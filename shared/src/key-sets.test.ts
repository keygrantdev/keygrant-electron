import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  importSigningKey,
  importVerifyingKey,
  importVerifyingKeys,
  keyId,
  signLease,
  verifyLease,
} from './crypto.js'
import type { LeaseInput } from './lease.js'

const NOW = 1_757_000_000_000

const INPUT: LeaseInput = {
  sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD',
  product: 'sluice',
  aid: 'act_1',
  model: 'perpetual',
  lim: 3,
  major: 1,
  ent: {},
  ttlSeconds: 3600,
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function headerOf(value: unknown): string {
  return b64url(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)))
}

describe('keyId', () => {
  it('is the RFC 7638 thumbprint of the key (the RFC 8037 example key)', async () => {
    // RFC 8037 appendix A.3: the thumbprint of its example Ed25519 public key.
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }
    expect(await keyId(jwk)).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k')
  })

  it('reads only the key: a kid member, other members and their order change nothing', async () => {
    const { publicJwk } = await generateKeyPair()
    const plain = await keyId(publicJwk)
    expect(await keyId({ x: publicJwk.x, crv: 'Ed25519', kty: 'OKP', kid: 'mine', use: 'sig' } as JsonWebKey)).toBe(plain)
  })

  it('throws for a JWK that is not an Ed25519 public key', async () => {
    await expect(keyId({ kty: 'EC', crv: 'P-256', x: 'AA' })).rejects.toThrow()
    await expect(keyId({ kty: 'OKP', crv: 'Ed25519', x: 'AAAA' })).rejects.toThrow()
    await expect(keyId({ kty: 'OKP', crv: 'Ed25519' })).rejects.toThrow()
  })
})

describe('importVerifyingKeys', () => {
  it('keeps the order given and a key given twice once', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const set = await importVerifyingKeys([a.publicJwk, b.publicJwk, a.publicJwk])
    expect(set.map((k) => k.kid)).toEqual([await keyId(a.publicJwk), await keyId(b.publicJwk)])
  })

  it('refuses an empty set', async () => {
    await expect(importVerifyingKeys([])).rejects.toThrow()
  })
})

describe('signLease with a kid', () => {
  it('names the key in the header in exactly the bytes a verifier matches, and names none without one', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const key = await importSigningKey(privateJwk)
    const kid = await keyId(publicJwk)
    const named = await signLease(INPUT, key, NOW, kid)
    const plain = await signLease(INPUT, key, NOW)
    const header = (t: string) => t.split('.')[0]
    // The segment itself, member order and all: a header names a key only in this exact form.
    expect(header(named)).toBe(headerOf(`{"alg":"EdDSA","typ":"JWT","kid":"${kid}"}`))
    expect(header(plain)).toBe(headerOf('{"alg":"EdDSA","typ":"JWT"}'))
  })
})

describe('verifyLease against a key set', () => {
  async function fixture() {
    const current = await generateKeyPair()
    const next = await generateKeyPair()
    const set = await importVerifyingKeys([current.publicJwk, next.publicJwk])
    return { current, next, set, currentKid: await keyId(current.publicJwk), nextKid: await keyId(next.publicJwk) }
  }

  it('verifies a lease naming the second key by that key', async () => {
    const f = await fixture()
    const lease = await signLease(INPUT, await importSigningKey(f.next.privateJwk), NOW, f.nextKid)
    expect((await verifyLease(lease, f.set, NOW)).valid).toBe(true)
  })

  it('tries each key in turn for a lease naming none', async () => {
    const f = await fixture()
    const byCurrent = await signLease(INPUT, await importSigningKey(f.current.privateJwk), NOW)
    const byNext = await signLease(INPUT, await importSigningKey(f.next.privateJwk), NOW)
    expect((await verifyLease(byCurrent, f.set, NOW)).valid).toBe(true)
    expect((await verifyLease(byNext, f.set, NOW)).valid).toBe(true)
  })

  it('refuses a lease naming a key the set does not hold as unknown-key, whoever signed it', async () => {
    const f = await fixture()
    const other = await generateKeyPair()
    const byOther = await signLease(INPUT, await importSigningKey(other.privateJwk), NOW, await keyId(other.publicJwk))
    const misnamed = await signLease(INPUT, await importSigningKey(f.current.privateJwk), NOW, 'not-a-key-of-this-set')
    expect(await verifyLease(byOther, f.set, NOW)).toEqual({ valid: false, reason: 'unknown-key' })
    expect(await verifyLease(misnamed, f.set, NOW)).toEqual({ valid: false, reason: 'unknown-key' })
  })

  it('verifies against the named key only: signed by the other key of the set is bad-signature', async () => {
    const f = await fixture()
    const lease = await signLease(INPUT, await importSigningKey(f.current.privateJwk), NOW, f.nextKid)
    expect(await verifyLease(lease, f.set, NOW)).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('is bad-signature for a lease naming no key that no key of the set signed', async () => {
    const f = await fixture()
    const other = await generateKeyPair()
    const lease = await signLease(INPUT, await importSigningKey(other.privateJwk), NOW)
    expect(await verifyLease(lease, f.set, NOW)).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('refuses to sign a key id outside the form a header names one by', async () => {
    const { privateJwk } = await generateKeyPair()
    const key = await importSigningKey(privateJwk)
    await expect(signLease(INPUT, key, NOW, '')).rejects.toThrow()
    await expect(signLease(INPUT, key, NOW, 'a"b')).rejects.toThrow()
    await expect(signLease(INPUT, key, NOW, 'k'.repeat(65))).rejects.toThrow()
  })

  it('judges a malformed signature before the kid: malformed, not unknown-key', async () => {
    const f = await fixture()
    const lease = await signLease(INPUT, await importSigningKey(f.current.privateJwk), NOW, 'unknown')
    const [h, p] = lease.split('.')
    expect(await verifyLease(`${h}.${p}.not+base64url`, f.set, NOW)).toEqual({ valid: false, reason: 'malformed' })
  })

  it('reads no header for a bare key: a lease naming any kid verifies by its signature alone', async () => {
    const f = await fixture()
    const lease = await signLease(INPUT, await importSigningKey(f.current.privateJwk), NOW, 'whatever')
    expect((await verifyLease(lease, await importVerifyingKey(f.current.publicJwk), NOW)).valid).toBe(true)
  })
})
