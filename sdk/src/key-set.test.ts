import { describe, it, expect } from 'vitest'
import { OPEN_MAJOR, fingerprintClaim, generateKeyPair, importSigningKey, keyId, signLease, type Entitlements } from '@keygrant/shared'
import { License } from './license.js'
import { MissingEntitlementError } from './entitlements.js'
import { NOW, PRODUCT, harness } from './license.fixture.js'

const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
const DAY_S = 86_400

/** A lease for the harness's licence, signed by `privateJwk`, naming `kid` when given. */
async function leaseBy(privateJwk: JsonWebKey, opts: { kid?: string; ent?: Entitlements; ttlSeconds?: number; now?: number } = {}) {
  const input = { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual' as const, lim: 3, major: 1, ent: opts.ent ?? {}, ttlSeconds: opts.ttlSeconds ?? 30 * DAY_S }
  return signLease(input, await importSigningKey(privateJwk), opts.now ?? NOW, opts.kid)
}

/** The harness's app, rebuilt with the key set `keys` (its storage, clock, device and server kept). */
function build(h: Awaited<ReturnType<typeof harness>>, keys: { publicJwks?: JsonWebKey[]; publicJwk?: JsonWebKey }) {
  return new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', ...keys, adapters: h.adapters })
}

describe('a key set', () => {
  it('activates on a lease the staged key signed when the build carries it, and reports the ids it carries', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    const nextKid = await keyId(next.publicJwk)
    const lease = await leaseBy(next.privateJwk, { kid: nextKid })
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    const app = build(h, { publicJwks: [h.publicJwk, next.publicJwk] })

    expect(await app.activate(KEY)).toEqual({ ok: true })
    expect((h.http.bodyOf('activate') as { kids: string[] }).kids).toEqual([await keyId(h.publicJwk), nextKid])
    expect(h.getStored()?.lease).toBe(lease)
  })

  it('refuses an activation whose lease names a key the build does not carry, storing nothing', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    const lease = await leaseBy(next.privateJwk, { kid: await keyId(next.publicJwk) })
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate(KEY)).toEqual({ ok: false, error: 'invalid-lease' })
    expect(h.getStored()?.lease).toBeUndefined()
  })

  it('answers a stored lease signed by a key the build does not carry as invalid, unknown-key, with the key, when the server cannot heal it', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseBy(next.privateJwk, { kid: await keyId(next.publicJwk) }) })
    h.http.fail = true

    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'unknown-key', key: KEY })
  })

  it('heals a stored lease signed by a key the build does not carry when the server signs with one it does', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseBy(next.privateJwk, { kid: await keyId(next.publicJwk) }) })
    const fresh = await h.sign(KEY, 'perpetual', 30 * DAY_S)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh } }))

    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('keeps the lease it holds when a renewal brings one signed by a key the build does not carry', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    // A day left of thirty: due to renew early.
    const held = await h.sign(KEY, 'perpetual', 30 * DAY_S, NOW - 29 * DAY_S * 1000)
    h.setStored({ key: KEY, activationId: 'act_1', lease: held })
    h.http.on('validate', async () => ({ status: 200, json: { lease: await leaseBy(next.privateJwk, { kid: await keyId(next.publicJwk) }) } }))

    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.count('validate')).toBe(1)
    expect(h.getStored()?.lease).toBe(held)
  })

  it('sends the ids of the keys it carries with each validate', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 2 * DAY_S) })
    h.http.on('validate', () => ({ status: 503, json: null }))
    await h.license.refresh()
    expect((h.http.bodyOf('validate') as { kids: string[] }).kids).toEqual([await keyId(h.publicJwk)])
  })

  it('takes publicJwk alone as a set of one: a lease naming its key verifies, and one naming none', async () => {
    const h = await harness()
    const app = build(h, { publicJwk: h.publicJwk })
    const named = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * DAY_S },
      h.signingKey,
      NOW,
      await keyId(h.publicJwk),
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease: named })
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 30 * DAY_S) })
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('refuses, when it is made, a key set holding a key that is not an Ed25519 public JWK', async () => {
    const h = await harness()
    const { privateJwk } = await generateKeyPair()
    expect(() => build(h, { publicJwks: [h.publicJwk, { kty: 'EC', crv: 'P-256', x: 'AA' }] })).toThrow(/public key 2/)
    expect(() => build(h, { publicJwks: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }] })).toThrow(/public key 1/)
    expect(() => build(h, { publicJwk: privateJwk })).toThrow(/private key/)
  })

  it('takes a key pasted with base64 padding, as every other SDK does', async () => {
    const h = await harness()
    const app = build(h, { publicJwks: [{ ...h.publicJwk, x: `${h.publicJwk.x}=` }] })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 30 * DAY_S) })
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('refuses a configuration with no key, an empty set, or both kinds', async () => {
    const h = await harness()
    expect(() => build(h, {})).toThrow(/publicJwks/)
    expect(() => build(h, { publicJwks: [] })).toThrow(/publicJwks/)
    expect(() => build(h, { publicJwk: h.publicJwk, publicJwks: [h.publicJwk] })).toThrow(/not both/)
  })

  it("refuses /pubkey's whole answer given where its keys go, saying publicJwks is an array", async () => {
    const h = await harness()
    expect(() => build(h, { publicJwks: { keys: [h.publicJwk] } as never })).toThrow(/an array of JWKs/)
  })
})

describe('has and require', () => {
  const ENT = { cloud: true, beta: false, seats: 0, devices: 5, edition: 'pro', blank: '' }

  async function licensedWith(ent: Entitlements) {
    const h = await harness()
    const lease = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent, ttlSeconds: 30 * DAY_S },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease })
    return h
  }

  it('answers from the stored lease: a flag on, a number not zero, a text not empty', async () => {
    const h = await licensedWith(ENT)
    expect(await h.license.has('cloud')).toBe(true)
    expect(await h.license.has('beta')).toBe(false)
    expect(await h.license.has('seats')).toBe(false)
    expect(await h.license.has('devices')).toBe(true)
    expect(await h.license.has('edition')).toBe(true)
    expect(await h.license.has('blank')).toBe(false)
    expect(await h.license.has('export')).toBe(false)
    expect(await h.license.has('constructor')).toBe(false)
  })

  it('never goes online and never writes', async () => {
    const h = await licensedWith(ENT)
    // A lease near its end, which status() would renew.
    h.setClock(NOW + 29 * DAY_S * 1000)
    const writes = h.writes()
    expect(await h.license.has('cloud')).toBe(true)
    expect(h.http.calls).toEqual([])
    expect(h.writes()).toBe(writes)
  })

  it('grants nothing on a lease that does not license this build, nor with no licence', async () => {
    const h = await licensedWith(ENT)
    h.setClock(NOW + 31 * DAY_S * 1000)
    expect(await h.license.has('cloud')).toBe(false)
    h.setStored(null)
    expect(await h.license.has('cloud')).toBe(false)
  })

  it('grants nothing over a stored refusal, though the lease it kept still verifies', async () => {
    const h = await licensedWith(ENT)
    // The server refused this build's major: the lease is kept for builds it covers.
    h.setStored({ ...h.getStored(), refused: 'upgrade', refusedMajor: 1 })
    expect(await h.license.has('cloud')).toBe(false)
    // Revoked: the refusal stands over any lease still held.
    h.setStored({ key: KEY, activationId: 'act_1', lease: h.getStored()?.lease, refused: 'revoked' })
    expect(await h.license.has('cloud')).toBe(false)
  })

  it('grants, during a running trial, what its trial lease signs', async () => {
    const h = await harness()
    const claim = await fingerprintClaim('fp-test')
    const trialLease = await signLease(
      { sub: `trial:${claim}`, product: PRODUCT, aid: claim, fpk: 'machine', model: 'trial', lim: 1, major: OPEN_MAJOR, ent: { cloud: true }, ttlSeconds: 7 * DAY_S },
      h.signingKey,
      NOW,
    )
    h.setStored({ trialStart: NOW, trialLease, lastSeen: NOW })
    expect(await h.license.has('cloud')).toBe(true)
    expect(await h.license.has('export')).toBe(false)
    // Read from the trial lease alone: no launch report, no ask.
    expect(h.http.calls).toEqual([])
    expect((await h.license.status()).state).toBe('trial')
  })

  it('grants nothing, without rejecting, while the state cannot be read', async () => {
    const h = await licensedWith(ENT)
    h.failRead(1)
    expect(await h.license.has('cloud')).toBe(false)
  })

  it('require resolves for a granted code and rejects naming the code otherwise', async () => {
    const h = await licensedWith(ENT)
    await expect(h.license.require('cloud')).resolves.toBeUndefined()
    const refused = await h.license.require('seats').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(MissingEntitlementError)
    expect(refused).toMatchObject({ entitlement: 'seats', name: 'MissingEntitlementError' })
  })
})
