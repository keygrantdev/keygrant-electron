import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_MAJOR, fingerprintClaim, generateKeyPair, importSigningKey, signLease } from '@keygrant/shared'
import { License } from './license.js'
import { STATUS_CHECK_TIMEOUT_MS } from './wire.js'
import { ASK_AGAIN_MS, CLOCK_TOLERANCE_MS, RENEW_WITHIN_MS, RETRY_UNANSWERED_MS } from './offline.js'
import { DEFAULT_HTTP_TIMEOUT_MS } from './adapters.js'
import type { Fingerprinter, StoredState } from './types.js'
import { hashFingerprint, hostnameFingerprint, nodeFingerprinter } from './adapters.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, MACHINE_ID_TIMEOUT_MS, type MachineIdSource } from './machine-id.js'
import { DAY, NOW, PRODUCT, harness, stuckCalls, type Stuck } from './license.fixture.js'

describe('activate', () => {
  it('cuts a device name the server would refuse', async () => {
    /**
     * The name comes from the integrating app and goes to a PUBLIC,
     * unauthenticated endpoint, which bounds every string it takes. Sent whole,
     * a long one turns a first activation into a 400, reported as `network`,
     * which is not what is wrong and not something the app can act on.
     *
     * It is a label in a device list. Cutting it is better than refusing the
     * activation it is attached to.
     */
    const h = await harness(null, { deviceName: 'D'.repeat(500) })
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    await h.license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')
    const sent = h.http.bodyOf('activate') as { name?: string }
    expect(sent.name).toHaveLength(120)
  })

  it('does not cut a character in half', async () => {
    // `slice` counts UTF-16 units, and an emoji is two of them. Cut between the
    // halves, the name ends in a lone surrogate, which is not a character, and
    // which some encoders turn into a replacement mark.
    const h = await harness(null, { deviceName: `${'D'.repeat(119)}😀` })
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    await h.license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')
    const sent = h.http.bodyOf('activate') as { name?: string }
    expect(sent.name).toBe('D'.repeat(119))
  })

  it('leaves a name of exactly the limit alone', async () => {
    const h = await harness(null, { deviceName: 'D'.repeat(120) })
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    await h.license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')
    const sent = h.http.bodyOf('activate') as { name?: string }
    expect(sent.name).toHaveLength(120)
  })

  it('refuses a key longer than one could be, by name', async () => {
    // Sent on, it comes back a 400 and is reported as `network`, which tells
    // the person to check their connection about something they typed.
    const h = await harness()
    expect(await h.license.activate('S'.repeat(200))).toEqual({ ok: false, error: 'invalid-key' })
    expect(h.http.called('activate')).toBe(false)
  })

  it('sends a key of exactly the limit, rather than refusing it', async () => {
    // The boundary the comparison is written on. Off by one, the longest key the
    // endpoint accepts is one the SDK never lets through.
    const key = `SLUICE-${'A'.repeat(113)}`
    expect(key).toHaveLength(120)
    const h = await harness()
    const lease = await h.sign(key, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate(key)).toEqual({ ok: true })
    expect((h.http.bodyOf('activate') as { key: string }).key).toBe(key)
  })

  it('activates on a key that was pasted with the whitespace around it', async () => {
    /**
     * A key arrives by pasting it out of an email, and a paste carries a
     * trailing newline more often than not. The lookup on the server is an
     * exact match, so sending it whole was a customer who had paid being told
     * their key was invalid.
     */
    const h = await harness()
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate('  SLUICE-AAAA-BBBB-CCCC-DDDD\n')).toEqual({ ok: true })
    const sent = h.http.bodyOf('activate') as { key: string }
    expect(sent.key).toBe('SLUICE-AAAA-BBBB-CCCC-DDDD')
    // And the STORED key is the trimmed one, so the deactivate that follows
    // names a key the server can find.
    expect(h.getStored()?.key).toBe('SLUICE-AAAA-BBBB-CCCC-DDDD')
  })

  it('does not count the whitespace around a key towards its length', async () => {
    // A key of exactly the limit, pasted. Measured before trimming, it is 121
    // characters and is refused without ever being tried.
    const key = `SLUICE-${'A'.repeat(113)}`
    const h = await harness()
    const lease = await h.sign(key, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate(`${key}\n`)).toEqual({ ok: true })
  })

  it('activates on a key somebody typed in lower case', async () => {
    /**
     * The same failure as the pasted newline, and the same justification: the
     * lookup on the server is an exact match against a format with no lower case
     * in it, so a key read off a receipt and typed in was a customer who had
     * paid being told their key was invalid.
     */
    const h = await harness()
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate('sluice-aaaa-bbbb-cccc-dddd')).toEqual({ ok: true })
    expect((h.http.bodyOf('activate') as { key: string }).key).toBe(
      'SLUICE-AAAA-BBBB-CCCC-DDDD',
    )
    // And the STORED key is the normalised one, so the deactivate that follows
    // names a key the server can find.
    expect(h.getStored()?.key).toBe('SLUICE-AAAA-BBBB-CCCC-DDDD')
  })

  it('refuses an empty key without asking anybody', async () => {
    // Whitespace is not a key, and that is knowable here. Sent on, it is a
    // round trip to learn something local.
    const h = await harness()
    expect(await h.license.activate('   ')).toEqual({ ok: false, error: 'invalid-key' })
    expect(h.http.called('activate')).toBe(false)
  })

  it('sends a device name that fits, unchanged', async () => {
    const h = await harness(null, { deviceName: 'Rae’s MacBook' })
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    await h.license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')
    const sent = h.http.bodyOf('activate') as { name?: string }
    expect(sent.name).toBe('Rae’s MacBook')
  })

  it('stores a verified lease and reports licensed', async () => {
    const h = await harness()
    const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    const result = await h.license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')
    expect(result).toEqual({ ok: true })
    expect(h.getStored()?.key).toBe('SLUICE-AAAA-BBBB-CCCC-DDDD')
    expect(h.getStored()?.activationId).toBe('act_1')

    const status = await h.license.status()
    expect(status.state).toBe('licensed')
    expect(status.key).toBe('SLUICE-AAAA-BBBB-CCCC-DDDD')
  })

  it.each([
    [404, 'invalid-key', 'invalid-key'],
    [409, 'limit', 'limit'],
    [403, 'revoked', 'revoked'],
    [403, 'expired', 'revoked'],
    [403, 'upgrade-required', 'upgrade'],
    [400, 'weird', 'network'],
  ])('maps server %i %s to error %s', async (status, serverError, expected) => {
    const h = await harness()
    h.http.on('activate', () => ({ status, json: { error: serverError } }))
    const result = await h.license.activate('KEY')
    expect(result).toEqual({ ok: false, error: expected })
  })

  it('returns network on a transport failure', async () => {
    const h = await harness()
    h.http.fail = true
    expect(await h.license.activate('KEY')).toEqual({ ok: false, error: 'network' })
  })

  it('returns network when the server 200s without a lease/activationId', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 200, json: { activationId: 'act_1' } })) // no lease
    expect(await h.license.activate('KEY')).toEqual({ ok: false, error: 'network' })
  })

  it('returns network, not invalid-lease, when the server 200s a lease with no activationId', async () => {
    // A lease that verifies, but nothing to hold the seat by: the answer is
    // not one the SDK can use, which is no answer, never a bad lease.
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease } }))
    expect(await h.license.activate('KEY')).toEqual({ ok: false, error: 'network' })
    expect(h.getStored()).toBeNull()
  })

  it('returns invalid-lease when the server lease fails offline verification', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 200, json: { lease: 'not.a.jwt', activationId: 'act_1' } }))
    expect(await h.license.activate('KEY')).toEqual({ ok: false, error: 'invalid-lease' })
  })
})

describe('status (offline-first)', () => {
  it('is unlicensed with no state', async () => {
    const h = await harness()
    expect((await h.license.status()).state).toBe('unlicensed')
  })

  it('is licensed from a valid lease without contacting the server', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })

    const status = await h.license.status()
    expect(status.state).toBe('licensed')
    expect(h.http.calls).toHaveLength(0) // offline-first: no network on a valid lease
  })

  it('renews online when the lease has expired', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY) // expired 2d ago
    const fresh = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))

    const status = await h.license.status()
    expect(status.state).toBe('licensed')
    expect(h.http.called('validate')).toBe(true)
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('stays expired-offline when an expired lease cannot be renewed (fail closed only past grace)', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.fail = true

    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('offline')
  })

  it.each([['revoked'], ['expired'], ['deactivated']])(
    'locks out (invalid/revoked) when renewal returns definitive %s',
    async (serverError) => {
      const h = await harness()
      const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
      h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
      h.http.on('validate', () => ({ status: 403, json: { error: serverError } }))

      const status = await h.license.status()
      expect(status.state).toBe('invalid')
      expect(status.reason).toBe('revoked')
    },
  )

  it('reports upgrade when renewal says upgrade-required', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'upgrade-required' } }))

    const status = await h.license.status()
    expect(status.state).toBe('invalid')
    expect(status.reason).toBe('upgrade')
  })

  it('falls back to expired-offline when the renewal lease is unverifiable', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: 'garbage.lease.value' } }))

    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('offline')
  })

  it('falls back to expired-offline when the renewal has no lease field', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: {} })) // 200 but no lease

    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('offline')
  })

  it('treats a transient 5xx renewal as an outage, not revocation', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 503, json: { error: 'unavailable' } }))

    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('offline') // NOT revoked
  })

  it('reports upgrade when the renewal lease covers a lower major than the app', async () => {
    const h = await harness(null, { major: 2 })
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    const freshMajor1 = await h.sign('KEY', 'perpetual', 30 * 24 * 3600) // covers major 1
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: freshMajor1, activationId: 'act_1' } }))

    const status = await h.license.status()
    expect(status.state).toBe('invalid')
    expect(status.reason).toBe('upgrade')
    expect(h.getStored()?.lease).toBe(freshMajor1) // valid lease still saved
  })

  it('reports tampered for a lease not signed by the product key (server unreachable)', async () => {
    const h = await harness()
    const other = await generateKeyPair()
    const foreignLease = await signLease(
      { sub: 'KEY', product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      await importSigningKey(other.privateJwk),
      NOW,
    )
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: foreignLease, lastSeen: NOW })
    h.http.fail = true // no heal available

    const status = await h.license.status()
    expect(status.state).toBe('invalid')
    expect(status.reason).toBe('tampered')
  })

  it('lets the server heal a locally-invalid lease (a fresh valid lease: licensed)', async () => {
    const h = await harness()
    const other = await generateKeyPair()
    const foreignLease = await signLease(
      { sub: 'KEY', product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      await importSigningKey(other.privateJwk),
      NOW,
    )
    const fresh = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: foreignLease, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))

    const status = await h.license.status()
    expect(status.state).toBe('licensed')
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('rejects a validly-signed lease issued for a different product', async () => {
    const h = await harness()
    // Signed by THIS product's real key (valid signature) but for another slug.
    const foreignProductLease = await signLease(
      { sub: 'KEY', product: 'other-app', aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: foreignProductLease, lastSeen: NOW })
    h.http.fail = true

    const status = await h.license.status()
    expect(status.state).toBe('invalid')
    expect(status.reason).toBe('tampered')
  })

  it('reports upgrade offline when the app major exceeds the lease coverage', async () => {
    const h = await harness(null, { major: 2 })
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600) // lease covers major 1
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.fail = true // no heal

    const status = await h.license.status()
    expect(status.state).toBe('invalid')
    expect(status.reason).toBe('upgrade')
  })

  it('ignores a rolled-back clock (cannot resurrect an expired lease)', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY) // expired
    // lastSeen is far in the future; a rolled-back clock must not help.
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW + 10 * DAY })
    h.setClock(NOW - 5 * DAY) // rewind the wall clock
    h.http.fail = true

    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('offline')
  })
})

describe('refresh (forced online)', () => {
  it('renews a still-valid lease and keeps it licensed', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    const fresh = await h.sign('KEY', 'perpetual', 30 * 24 * 3600, NOW + 1000)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))

    const status = await h.license.refresh()
    expect(status.state).toBe('licensed')
    expect(h.http.called('validate')).toBe(true)
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('keeps a valid lease licensed when the forced renewal cannot reach the server', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.fail = true

    const status = await h.license.refresh()
    expect(status.state).toBe('licensed') // fail in favor of the paying customer
  })

  it('keeps a valid lease licensed when the forced renewal hits a transient 5xx', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 500, json: { error: 'boom' } }))

    const status = await h.license.refresh()
    expect(status.state).toBe('licensed')
  })

  it('keeps a valid lease licensed on a 429 rate-limit', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 429, json: { error: 'rate-limited' } }))

    expect((await h.license.refresh()).state).toBe('licensed')
  })

  it('does not lock out a valid lease on an ambiguous 4xx (e.g. proxy 404)', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 404, json: { error: 'unknown-product' } }))

    expect((await h.license.refresh()).state).toBe('licensed')
  })
})

describe('default adapters', () => {
  /**
   * The engine with its default storage, where `./adapters.js` names the paths
   * (the per-user folder, and the old SDK's) as folders of this test's own: the
   * engine is imported afresh to take the stand-in, and a test writes nowhere
   * real.
   */
  async function withDefaultPaths(test: (dir: string, Fresh: typeof License) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'keygrant-'))
    vi.resetModules()
    vi.doMock('./adapters.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./adapters.js')>()),
      defaultStoragePath: (product: string) => join(dir, 'user', `${product}.json`),
      legacyStoragePath: (product: string) => join(dir, 'app', '.keygrant', `${product}.json`),
    }))
    try {
      const { License: Fresh } = await import('./license.js')
      await test(dir, Fresh)
    } finally {
      vi.doUnmock('./adapters.js')
      vi.resetModules()
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('constructs with no adapter overrides and reads unlicensed for a fresh product', () =>
    withDefaultPaths(async (_dir, Fresh) => {
      // Every adapter the default; the storage paths alone are this test's own
      // folders (withDefaultPaths), so nothing real is read or written.
      const { publicJwk } = await generateKeyPair()
      const license = new Fresh({ product: PRODUCT, apiBaseUrl: 'https://api.test', publicJwk })
      expect((await license.status()).state).toBe('unlicensed')
    }))

  it('keeps its state at defaultStoragePath when the app gives no storage', () =>
    withDefaultPaths(async (dir, Fresh) => {
      const h = await harness()
      const { registry, clock, fingerprint, http } = h.adapters
      const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
      h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
      const license = new Fresh({
        product: PRODUCT,
        apiBaseUrl: 'https://api.test/',
        publicJwk: h.publicJwk,
        adapters: { registry, clock, fingerprint, http },
      })

      expect(await license.activate('SLUICE-AAAA-BBBB-CCCC-DDDD')).toEqual({ ok: true })
      const saved = JSON.parse(await readFile(join(dir, 'user', `${PRODUCT}.json`), 'utf8')) as StoredState
      expect(saved).toMatchObject({ key: 'SLUICE-AAAA-BBBB-CCCC-DDDD', activationId: 'act_1', lease })
    }))

  it('migrates the state an older SDK kept in the working directory, and licenses from it', () =>
    withDefaultPaths(async (dir, Fresh) => {
      const h = await harness()
      const { registry, clock, fingerprint, http } = h.adapters
      const lease = await h.sign('SLUICE-AAAA-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600)
      const old = { key: 'SLUICE-AAAA-BBBB-CCCC-DDDD', activationId: 'act_1', lease, lastSeen: NOW }
      await mkdir(join(dir, 'app', '.keygrant'), { recursive: true })
      await writeFile(join(dir, 'app', '.keygrant', `${PRODUCT}.json`), JSON.stringify(old), 'utf8')
      const license = new Fresh({
        product: PRODUCT,
        apiBaseUrl: 'https://api.test/',
        publicJwk: h.publicJwk,
        adapters: { registry, clock, fingerprint, http },
      })

      expect((await license.status()).state).toBe('licensed')
      const migrated = JSON.parse(await readFile(join(dir, 'user', `${PRODUCT}.json`), 'utf8')) as StoredState
      expect(migrated).toMatchObject(old)
    }))
})

describe('deactivate', () => {
  it('releases the activation and clears local state', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))

    expect(await h.license.deactivate()).toEqual({ released: true })
    expect(h.http.called('deactivate')).toBe(true)
    expect(h.getStored()?.key).toBeUndefined()
    expect((await h.license.status()).state).toBe('unlicensed')
  })

  it('clears local state even if the server is unreachable, and says the seat may still be held', async () => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.fail = true

    expect(await h.license.deactivate()).toEqual({ released: false })
    expect(h.getStored()?.key).toBeUndefined()
    expect((await h.license.status()).state).toBe('unlicensed')
  })

  it.each([
    [503, { error: 'internal' }],
    [429, { error: 'rate-limited' }],
    [403, '<html>blocked by policy</html>'],
  ])('takes only a 200 as the seat released: a %s is an answer, but not that one', async (status, json) => {
    const h = await harness()
    const lease = await h.sign('KEY', 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease, lastSeen: NOW })
    h.http.on('deactivate', () => ({ status, json }))

    expect(await h.license.deactivate()).toEqual({ released: false })
    // Dropped all the same: the customer asked to remove the key here.
    expect(h.getStored()?.key).toBeUndefined()
  })

  it('is a no-op when there is no local activation to release, which leaves no seat held', async () => {
    const h = await harness()
    expect(await h.license.deactivate()).toEqual({ released: true })
    expect(h.http.called('deactivate')).toBe(false) // nothing to POST
    expect((await h.license.status()).state).toBe('unlicensed')
  })
})

describe('trial', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a trial, verifies the lease, and stashes the start earliest', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))

    const status = await h.license.startTrial()
    expect(status.state).toBe('trial')
    expect(status.trialDaysLeft).toBe(5)
    expect(h.getStored()?.trialStart).toBe(NOW - 2 * DAY)
    expect(h.getRegistry()).toBe(NOW - 2 * DAY) // mirrored to the registry stash
  })

  it('never moves the trial start forward (anti-reset)', async () => {
    const h = await harness({ trialStart: NOW - 10 * DAY })
    h.setRegistry(NOW - 8 * DAY)
    const trialLease = await h.sign('trial:fp-test', 'trial', 4 * 24 * 3600)
    // Server reports a LATER start; the earliest local evidence must win.
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 4 * DAY, lease: trialLease } }))

    await h.license.startTrial()
    expect(h.getStored()?.trialStart).toBe(NOW - 10 * DAY)
  })

  it('falls back to local trial evidence when offline', async () => {
    const h = await harness()
    // Signed by THIS harness's key: a lease another key signed is no trial at all.
    const validTrial = await h.sign('trial:fp-test', 'trial', 6 * 24 * 3600)
    h.setStored({ trialStart: NOW - 1 * DAY, trialEndsAt: NOW + 6 * DAY, trialLease: validTrial, lastSeen: NOW })
    h.http.fail = true

    const status = await h.license.startTrial()
    expect(status.state).toBe('trial')
  })

  it('falls back to local evidence when the trial endpoint returns non-200', async () => {
    const h = await harness()
    const validTrial = await h.sign('trial:fp-test', 'trial', 6 * 24 * 3600)
    h.setStored({ trialStart: NOW - 1 * DAY, trialEndsAt: NOW + 6 * DAY, trialLease: validTrial, lastSeen: NOW })
    // A trial-shaped body that would end the trial, were anything but a 200 taken.
    h.http.on('trial', () => ({ status: 400, json: { trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY } }))

    expect((await h.license.startTrial()).state).toBe('trial')
    expect(h.getStored()).toMatchObject({ trialEndsAt: NOW + 6 * DAY, trialLease: validTrial })
  })

  it.each<[string, number, number]>([
    ["the stash's, when it is earliest", NOW - 3 * DAY, NOW - 5 * DAY],
    ['the stored one, when it is earliest', NOW - 5 * DAY, NOW - 3 * DAY],
  ])('asks with the earliest start the device holds: %s', async (_case, storedStart, stashStart) => {
    const h = await harness({ trialStart: storedStart })
    h.setRegistry(stashStart)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 5 * DAY, trialEndsAt: NOW + 5 * DAY } }))

    await h.license.startTrial()
    expect(h.http.bodyOf('trial')).toMatchObject({ clientStart: NOW - 5 * DAY })
  })

  it('waits the activation bound for the machine id when a trial is started, not the 2 s a status() gets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stuck = stuckCalls()
    const h = await harness(null, { fingerprint: { get: () => stuck.hang<string>() } })
    let settled = false
    const started = h.license.startTrial().then((s) => {
      settled = true
      return s
    })
    await stuck.when(1)
    await vi.advanceTimersByTimeAsync(ACTIVATE_MACHINE_ID_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    // This device could not be told: no trial is asked for, and none is held.
    expect(await started).toEqual({ state: 'unlicensed' })
    expect(h.http.called('trial')).toBe(false)
  })

  it('answers unlicensed for a trial lease stored without a start, asking nothing', async () => {
    // Only a stored start is a trial this device began; no save leaves a lease or an end without
    // one.
    const h = await harness()
    h.setStored({ trialEndsAt: NOW + 5 * DAY, trialLease: await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600), lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('trial')).toBe(false)
  })

  it('tells the server a machine id keys the trial, and says nothing of a fingerprint of no kind', async () => {
    const machine: Fingerprinter = {
      async get() {
        return 'fp-machine'
      },
      async identify() {
        return { fingerprint: 'fp-machine', kind: 'machine', alternates: [] }
      },
    }
    const h = await harness(null, { fingerprint: machine })
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY } }))
    await h.license.startTrial()
    expect(h.http.bodyOf('trial')).toMatchObject({ fingerprint: 'fp-machine', fingerprintKind: 'machine' })

    const plain = await harness()
    plain.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY } }))
    await plain.license.startTrial()
    expect(plain.http.bodyOf('trial')).not.toHaveProperty('fingerprintKind')
  })

  it('takes a valid trial lease the server answers with over the valid one stored', async () => {
    // An extension, or a lease carrying new entitlements: the server's word wins
    // whenever its lease verifies here.
    const h = await harness()
    const ours = await h.sign('trial:fp-test', 'trial', 3 * 24 * 3600)
    h.setStored({ trialStart: NOW - 4 * DAY, trialEndsAt: NOW + 3 * DAY, trialLease: ours, lastSeen: NOW })
    const extended = await signLease(
      { sub: 'trial:fp-test', product: PRODUCT, aid: 'act_1', model: 'trial', lim: 1, major: 1, ent: { edition: 'pro' }, ttlSeconds: 6 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 4 * DAY, trialEndsAt: NOW + 6 * DAY, lease: extended } }))

    expect(await h.license.startTrial()).toEqual({ state: 'trial', trialEndsAt: NOW + 6 * DAY, trialDaysLeft: 6, entitlements: { edition: 'pro' } })
    expect(h.getStored()?.trialLease).toBe(extended)
  })

  it('saves its answer over a stored trial stamped ahead of the clock, the stamp being the one it saw', async () => {
    // The stored stamp is a day ahead (a clock put back since): this process
    // saw it when it asked, so its answer is the newer one, not an older one
    // from another process.
    const h = await harness()
    const old = await h.sign('trial:fp-test', 'trial', 2 * 24 * 3600)
    h.setStored({ trialStart: NOW - 5 * DAY, trialEndsAt: NOW + 2 * DAY, trialLease: old, trialAt: NOW + DAY, lastSeen: NOW })
    const fresh = await h.sign('trial:fp-test', 'trial', 4 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 5 * DAY, trialEndsAt: NOW + 4 * DAY, lease: fresh } }))

    await h.license.startTrial()
    expect(h.getStored()).toMatchObject({ trialEndsAt: NOW + 4 * DAY, trialLease: fresh })
  })

  it('ignores a malformed trial body (missing numeric fields)', async () => {
    const h = await harness()
    h.http.on('trial', () => ({ status: 200, json: { trialStart: 'oops', lease: 'x' } })) // not numbers

    const status = await h.license.startTrial()
    // Nothing valid to store: still unlicensed, and no corrupt trialStart written.
    expect(status.state).toBe('unlicensed')
    expect(h.getStored()?.trialStart).toBeUndefined()
  })

  it('starts the trial all the same when the stash cannot be read', async () => {
    /**
     * The stash is the app's own adapter. One that throws must not reject startTrial(), which an
     * app awaits at launch: that would be a crash, or an activation screen, for a customer who had
     * done nothing wrong.
     */
    const h = await harness()
    h.failRegistry({ read: true })
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))

    expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    expect(h.getStored()?.trialStart).toBe(NOW - 2 * DAY)
    // No evidence from it, so nothing sent as the client's start: on the wire,
    // as JSON, which drops an unset field.
    const sent = h.http.calls.filter((c) => c.action === 'trial').at(-1)?.body
    expect(JSON.parse(JSON.stringify(sent))).not.toHaveProperty('clientStart')
    // A read that failed is no reason not to write: the stash is mirrored with
    // the server's start, so it holds the trial from now on.
    expect(h.getRegistry()).toBe(NOW - 2 * DAY)
  })

  it("takes the stored start as the client's, and saves the earliest, when the stash cannot be read", async () => {
    /**
     * The stash is one piece of evidence of when the trial began; the state
     * stored on disk is another. A stash that cannot be read must cost neither
     * the stored start nor the anti-reset rule: the client's start is the
     * stored one, and the start saved (and mirrored) is the earliest of it and
     * the server's.
     */
    const h = await harness({ trialStart: NOW - 5 * DAY, lastSeen: NOW })
    h.failRegistry({ read: true })
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    // The server reports a later start than the one stored here.
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))

    expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    expect(h.http.bodyOf('trial')).toMatchObject({ clientStart: NOW - 5 * DAY })
    expect(h.getStored()?.trialStart).toBe(NOW - 5 * DAY)
    expect(h.getRegistry()).toBe(NOW - 5 * DAY)
  })

  it("keeps the server's trial when the stash cannot be written", async () => {
    const h = await harness()
    h.failRegistry({ write: true })
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))

    expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    // Saved, though it could not be mirrored: the stash is a copy, not the record.
    expect(h.getStored()).toMatchObject({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease })
    expect(h.getRegistry()).toBeNull()
  })

  it('restores the earliest start from the registry when local storage was wiped', async () => {
    const h = await harness() // no local trial state
    h.setRegistry(NOW - 10 * DAY)
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    // Server reports a later start; the registry evidence is earlier and must win.
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))

    await h.license.startTrial()
    expect(h.getStored()?.trialStart).toBe(NOW - 10 * DAY)
  })

  it('keeps a trial it could not save out of a call that runs read-only behind a stuck one', async () => {
    // The trial the disk refused is saved by the next call that CAN write; one
    // running read-only behind a stuck call answers it but writes nothing.
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    h.failWrites()
    expect((await h.license.startTrial()).state).toBe('trial')
    h.failWrites(false)
    const failedWrites = h.writes()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.hangNextRead()
    void h.license.status()
    const later = h.license.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5, stalled: true })
    expect(h.writes()).toBe(failedWrites)
    expect(h.getStored()).toBeNull()
  })

  it('runs no trial on a stored trialEndsAt alone: unsigned, it could be edited into any trial', async () => {
    const h = await harness({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY })
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
  })

  it('ends a trial when its signed lease ends, whatever end is stored beside it', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 2 * 24 * 3600)
    // Someone edited the stored end a year out.
    h.setStored({ trialStart: NOW - 5 * DAY, trialEndsAt: NOW + 365 * DAY, trialLease, lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'trial', trialEndsAt: NOW + 2 * DAY, trialDaysLeft: 2 })

    // And the same file, read once the lease has ended: the edit buys nothing.
    h.setClock(NOW + 2 * DAY + 1000)
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
  })

  it('reports expired once the trial window has passed', async () => {
    const h = await harness({ trialStart: NOW - 10 * DAY, trialEndsAt: NOW - 1 * DAY })
    const status = await h.license.status()
    expect(status.state).toBe('expired')
    expect(status.reason).toBe('trial')
  })

  it('is live from a valid trial lease via status()', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease, lastSeen: NOW })
    const status = await h.license.status()
    expect(status.state).toBe('trial')
    expect(status.trialDaysLeft).toBe(5)
  })

  it('keeps the trial lease it can verify when the server answers with one it cannot', async () => {
    // The product's key rotated ahead of this build: every answer is signed with a key the
    // build does not carry. Taking it would end the running trial at the next sync.
    const h = await harness()
    const ours = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease: ours, lastSeen: NOW })
    const rotated = await (await harness()).sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: rotated } }))

    expect(await h.license.startTrial()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5 })
    expect(h.getStored()?.trialLease).toBe(ours)
  })

  it("takes the server's word when it says the trial is over, whatever lease is held", async () => {
    const h = await harness()
    const ours = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease: ours, lastSeen: NOW })
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY } }))

    expect(await h.license.startTrial()).toEqual({ state: 'expired', reason: 'trial' })
  })

  describe('a trial whose lease does not verify while its stored end is ahead', () => {
    /** A trial stored with a lease signed by another key: one the product signed before a rotation. */
    async function rotated(over: StoredState = {}, opts: Parameters<typeof harness>[1] = {}) {
      const h = await harness(null, opts)
      const stale = await (await harness()).sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease: stale, lastSeen: NOW, ...over })
      return h
    }

    it("asks for the trial again, and the server's fresh lease runs it", async () => {
      const h = await rotated()
      const fresh = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: fresh } }))

      expect(await h.license.status()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5 })
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(1)
      expect(h.getStored()).toMatchObject({ trialLease: fresh })
      // Healed, so no wait is recorded: the next heal (a later rotation) is not held off.
      expect(h.getStored()?.backoffSince).toBeUndefined()
      // Healed: the next status() needs no ask.
      await h.license.status()
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(1)
    })

    it("heals a trial lease signed short of the trial's end", async () => {
      const h = await harness()
      // Seven days on a fourteen-day trial.
      const capped = await h.sign('trial:fp-test', 'trial', 7 * 24 * 3600)
      h.setStored({ trialStart: NOW, trialEndsAt: NOW + 14 * DAY, trialLease: capped, lastSeen: NOW })
      h.setClock(NOW + 8 * DAY)
      const fresh = await h.sign('trial:fp-test', 'trial', 6 * 24 * 3600, NOW + 8 * DAY)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 14 * DAY, lease: fresh } }))

      expect(await h.license.status()).toMatchObject({ state: 'trial', trialDaysLeft: 6 })
    })

    it('answers expired, and waits a minute, when the server cannot be reached', async () => {
      const h = await rotated()
      h.http.fail = true

      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: 60_000 })
      // Within the wait, no ask: a status() offline does not pay a timeout each time.
      await h.license.status()
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(1)
      h.setClock(NOW + 60_000)
      await h.license.status()
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(2)
    })

    it('times the wait by the device clock, not the guard, when the clock was set back', async () => {
      // The guard (lastSeen) is a day ahead of this device's clock: a wait stamped by
      // the guard would read as not yet started, and every status() would pay the ask.
      const h = await rotated({ lastSeen: NOW + DAY })
      h.http.fail = true

      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: 60_000 })
      await h.license.status()
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(1)
    })

    it('waits an hour when the server answers with nothing this build can verify', async () => {
      const h = await rotated()
      // A build carrying a key the product no longer signs with: the answer cannot verify either.
      const stillStale = await (await harness()).sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: stillStale } }))

      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: 3_600_000 })
      // Neither verifies, so nothing is kept over the server's: its lease is the one stored.
      expect(h.getStored()?.trialLease).toBe(stillStale)
    })

    it('asks nothing on a run that cannot tell who the device is, and waits a minute', async () => {
      const h = await rotated()
      const cannotTell = await harness(h.getStored(), {
        fingerprint: {
          async get(): Promise<string> {
            throw new Error('the machine id cannot be read just now')
          },
        },
      })
      cannotTell.setStored(h.getStored())

      expect(await cannotTell.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(cannotTell.http.called('trial')).toBe(false)
      expect(cannotTell.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: 60_000 })
    })

    it("takes the server's word that the trial is over", async () => {
      const h = await rotated()
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY } }))

      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ trialEndsAt: NOW - 2 * DAY })
    })

    it('asks again inside the wait when refreshed', async () => {
      const h = await rotated({ backoffSince: NOW - 60_000, backoffMs: ASK_AGAIN_MS })
      const fresh = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: fresh } }))

      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.http.called('trial')).toBe(false)
      expect(await h.license.refresh()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5 })
    })

    it('neither asks nor writes behind a call that has not finished', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const h = await rotated()
      const fresh = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: fresh } }))
      h.hangNextRead()
      void h.license.status()
      const later = h.license.status()
      await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)

      expect(await later).toEqual({ state: 'expired', reason: 'trial', stalled: true })
      expect(h.http.called('trial')).toBe(false)
      expect(h.writes()).toBe(0)
    })

    it.each<[string, { status: number; json: unknown }]>([
      ['a 404', { status: 404, json: { error: 'unknown-product' } }],
      ['a 200 it cannot read', { status: 200, json: { trialStart: 'soon' } }],
    ])('waits an hour after %s, the server having answered', async (_case, answer) => {
      const h = await rotated()
      h.http.on('trial', () => answer)
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: ASK_AGAIN_MS })
    })

    it('asks nothing when the stored end is exactly now', async () => {
      const h = await rotated({ trialEndsAt: NOW })
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.http.called('trial')).toBe(false)
    })

    it('bounds its ask as a status check is, and waits a minute after one that got no answer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const h = await rotated()
      h.http.hang = true
      let settled = false
      const pending = h.license.status().then((s) => {
        settled = true
        return s
      })
      await h.http.whenCalled('trial')
      await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await pending).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    })

    it('reads the machine id for its ask with the 2 s a status() gets, not the activation bound', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stuck = stuckCalls()
      const h = await rotated({}, { fingerprint: { get: () => stuck.hang<string>() } })
      let settled = false
      const pending = h.license.status().then((s) => {
        settled = true
        return s
      })
      // The stored trial lease's check reads the device first; then the heal reads it again.
      await stuck.when(1)
      await vi.advanceTimersByTimeAsync(MACHINE_ID_TIMEOUT_MS)
      await stuck.when(2)
      await vi.advanceTimersByTimeAsync(MACHINE_ID_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      // A device that could not be told asks for no trial, and waits a minute.
      expect(await pending).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.http.called('trial')).toBe(false)
      expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    })

    it('asks nothing once the stored end has passed, or when the lease verifies', async () => {
      const h = await rotated({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 1 })
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })

      const valid = await harness()
      valid.setStored({
        trialStart: NOW - 2 * DAY,
        trialEndsAt: NOW + 5 * DAY,
        trialLease: await valid.sign('trial:fp-test', 'trial', 5 * 24 * 3600),
        // Synced within the day, so no launch report is due either (trials.ts `reportLaunch`).
        trialAt: NOW - DAY / 2,
        lastSeen: NOW,
      })
      expect((await valid.license.status()).state).toBe('trial')
      expect(h.http.calls.filter((c) => c.action === 'trial')).toHaveLength(0)
      expect(valid.http.calls.filter((c) => c.action === 'trial')).toHaveLength(0)
    })
  })

  it("takes the trial's end from its lease when none is stored", async () => {
    const h = await harness()
    // As the server signs one: the device's fingerprint as its `aid`.
    const claim = await fingerprintClaim('fp-test')
    const trialLease = await signLease(
      { sub: `trial:${claim}`, product: PRODUCT, aid: claim, model: 'trial', lim: 1, major: OPEN_MAJOR, ent: {}, ttlSeconds: 7 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.setStored({ trialStart: NOW - 2 * DAY, trialLease, lastSeen: NOW }) // no trialEndsAt
    expect(await h.license.status()).toEqual({ state: 'trial', trialEndsAt: NOW + 7 * DAY, trialDaysLeft: 7 })
  })
})

describe('test licences', () => {
  const KEY = 'SLUICE-TEST-TEST-TEST-TEST'
  /** A lease as the server signs one for a test licence: the real key, plus `test`. */
  async function testLease(h: Awaited<ReturnType<typeof harness>>, ttlSeconds = 30 * 24 * 3600, now = NOW): Promise<string> {
    return signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, test: true, ttlSeconds },
      h.signingKey,
      now,
    )
  }

  it('licenses the app, and says it is a test licence so a release build can refuse it', async () => {
    const h = await harness()
    const lease = await testLease(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, test: true })
  })

  it('says nothing about it on a real licence', async () => {
    // Absent, not `false`, so an app comparing the whole status sees no change.
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    await h.license.activate(KEY)
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('keeps saying so after a renewal', async () => {
    // From an EXPIRED lease, so the status can only come from the renewed one:
    // a failed renewal would answer "expired", not fall back to a cached lease.
    const h = await harness()
    const short = await testLease(h, 60)
    h.http.on('activate', () => ({ status: 200, json: { lease: short, activationId: 'act_1' } }))
    await h.license.activate(KEY)

    const later = NOW + 2 * 3600_000
    h.setClock(later)
    const fresh = await testLease(h, 30 * 24 * 3600, later)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh } }))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, test: true })
    expect(h.http.calls.some((c) => c.action === 'validate')).toBe(true)
  })

  it('keeps saying so when a forced refresh cannot reach the server', async () => {
    // The offline fallback keeps the lease it holds, and that lease is still a
    // test licence: a release build refusing test keys must not be talked out
    // of it by a dropped connection.
    const h = await harness()
    const lease = await testLease(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    await h.license.activate(KEY)

    h.http.fail = true
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY, test: true })
    // It did try: the answer is the fallback, not a status that never asked.
    expect(h.http.calls.map((c) => c.action)).toEqual(['activate', 'validate'])
  })
})

describe('entitlements', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const KEY = 'SLUICE-ENTL-ENTL-ENTL-ENTL'
  const PRO = { edition: 'pro', seats: 5, beta: false }
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  /**
   * A lease signed with the harness's key over any claims, `ent` included as
   * given, malformed or not (signLease refuses a malformed one, as the server
   * never signs it; an SDK still has to read one).
   */
  async function signedWith(h: Awaited<ReturnType<typeof harness>>, over: Record<string, unknown>, now = NOW): Promise<string> {
    const iat = Math.floor(now / 1000)
    const claims = { iss: 'keygrant', sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 1, iat, exp: iat + 30 * 24 * 3600, ...over }
    const input = `${segment({ alg: 'EdDSA', typ: 'JWT' })}.${segment(claims)}`
    const signature = await crypto.subtle.sign('Ed25519', h.signingKey, new TextEncoder().encode(input))
    return `${input}.${Buffer.from(signature).toString('base64url')}`
  }

  async function activated(h: Awaited<ReturnType<typeof harness>>, lease: string): Promise<void> {
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
  }

  it('hands the app what the lease grants, once activated', async () => {
    const h = await harness()
    await activated(h, await signedWith(h, { ent: PRO }))
    const status = await h.license.status()
    expect(status).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })
    expect(status.entitlements?.edition === 'pro').toBe(true)
  })

  it('says nothing of them when the lease grants none, absent rather than empty', async () => {
    // As `test`: an app comparing the whole status sees no change.
    const h = await harness()
    await activated(h, await signedWith(h, { ent: {} }))
    const status = await h.license.status()
    expect(status).toEqual({ state: 'licensed', key: KEY })
    expect('entitlements' in status).toBe(false)
  })

  it('keeps the good members of a malformed ent, and the licence it rides on', async () => {
    const h = await harness()
    const lease = await signedWith(h, { ent: { edition: 'pro', nested: { tier: 'gold' }, none: null, list: [1], seats: 2 } })
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, entitlements: { edition: 'pro', seats: 2 } })
  })

  it('reads an ent that is not an object as none, never as a refusal', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: ['pro'] }), checkedMajor: 1, lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('takes them from the renewed lease, not the one it replaced', async () => {
    // From an EXPIRED lease, so the status can only come from the renewal.
    const h = await harness()
    await activated(h, await signedWith(h, { ent: { edition: 'basic' }, exp: Math.floor(NOW / 1000) + 60 }))
    const later = NOW + 2 * 3600_000
    h.setClock(later)
    const fresh = await signedWith(h, { ent: PRO }, later)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh } }))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })
    expect(h.http.called('validate')).toBe(true)
  })

  it("refresh(): the new lease's when the server answers, the held lease's when it cannot", async () => {
    const h = await harness()
    await activated(h, await signedWith(h, { ent: { edition: 'basic' } }))
    h.http.on('validate', async () => ({ status: 200, json: { lease: await signedWith(h, { ent: PRO }) } }))
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })

    h.http.fail = true
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })
    expect(h.http.calls.map((c) => c.action)).toEqual(['activate', 'validate', 'validate'])
  })

  it("carries a test licence's beside its test flag", async () => {
    const h = await harness()
    await activated(h, await signedWith(h, { ent: PRO, test: true }))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, test: true, entitlements: PRO })
  })

  it('carries none on a status that does not license, though the lease grants them', async () => {
    const h = await harness(null, { major: 2 })
    h.http.fail = true
    // A newer build than the lease covers.
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: PRO }), lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
    // A lease past its end, the server out of reach.
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: PRO, major: 2, exp: Math.floor(NOW / 1000) - 1 }), lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
    // A lease for another key.
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: PRO, major: 2, sub: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }), lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'tampered' })
  })

  it('carries none on a refusal the server gave, though the lease it keeps grants them', async () => {
    // An upgrade refusal keeps the lease (a rollback runs offline on it), so
    // the entitlements are still on the device: the refusal must not carry them.
    const h = await harness()
    await activated(h, await signedWith(h, { ent: PRO }))
    h.http.on('validate', () => ({ status: 403, json: { error: 'upgrade-required' } }))
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
    expect(h.getStored()?.lease).toBeDefined()
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
  })

  it('carries none on a stored refusal answered behind a call that has not finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    const lease = await signedWith(h, { ent: PRO })
    h.setStored({ key: KEY, activationId: 'act_1', lease, refused: 'upgrade', refusedMajor: 1, checkedMajor: 1, lastSeen: NOW })
    h.hangNextRead()
    void h.license.status()
    const later = h.license.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY, stalled: true })
  })

  it("keeps the held lease's when an early renewal gets no answer", async () => {
    // Five days left of thirty: due to renew early, and the server is out of reach.
    const h = await harness()
    const lease = await signedWith(h, { ent: PRO, iat: Math.floor(NOW / 1000) - 25 * 86_400, exp: Math.floor(NOW / 1000) + 5 * 86_400 })
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })
    expect(h.http.calls.map((c) => c.action)).toEqual(['validate'])
  })

  it("hands a trial the trial lease's, from startTrial() and every status() after", async () => {
    const h = await harness()
    const trialLease = await signedWith(h, { sub: 'trial:fp-test', model: 'trial', ent: PRO, exp: Math.floor(NOW / 1000) + 5 * 86_400 })
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    const trial = { state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5, entitlements: PRO }
    expect(await h.license.startTrial()).toEqual(trial)
    h.http.fail = true
    expect(await h.license.status()).toEqual(trial)
  })

  it('gives a trial none once its lease no longer runs it', async () => {
    const h = await harness()
    const trialLease = await signedWith(h, { sub: 'trial:fp-test', model: 'trial', ent: PRO, exp: Math.floor(NOW / 1000) + 86_400 })
    h.setStored({ trialStart: NOW - 6 * DAY, trialEndsAt: NOW + DAY, trialLease, lastSeen: NOW })
    h.setClock(NOW + 2 * DAY)
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
  })

  it('still carries them behind a call that has not finished, from the lease held', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: PRO }), checkedMajor: 1, lastSeen: NOW })
    h.hangNextRead()
    void h.license.status()
    const later = h.license.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toEqual({ state: 'licensed', key: KEY, entitlements: PRO, stalled: true })
  })

  it('cannot be changed through a status, which leaves the next status as the lease says', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await signedWith(h, { ent: PRO }), checkedMajor: 1, lastSeen: NOW })
    const first = await h.license.status()
    expect(Object.isFrozen(first.entitlements)).toBe(true)
    expect(() => {
      ;(first.entitlements as Record<string, unknown>).edition = 'studio'
    }).toThrow(TypeError)
    expect((await h.license.status()).entitlements).toEqual(PRO)
  })
})

describe('a key for a range of versions', () => {
  /** A lease from the product's key covering `minMajor` (absent: 1) to `major`. */
  async function rangeLease(h: Awaited<ReturnType<typeof harness>>, major: number, minMajor?: number, now = NOW) {
    return signLease(
      {
        sub: 'KEY',
        product: PRODUCT,
        aid: 'act_1',
        model: 'perpetual',
        lim: 3,
        major,
        ...(minMajor !== undefined ? { minMajor } : {}),
        ent: {},
        ttlSeconds: 30 * 24 * 3600,
      },
      h.signingKey,
      now,
    )
  }

  it('reports outdated offline for a build older than the key covers', async () => {
    // A key sold for 2.x on a 1.x build: updating the app is the fix, not buying.
    const h = await harness(null, { major: 1 })
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: await rangeLease(h, 3, 2), lastSeen: NOW })
    h.http.fail = true

    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'outdated', key: 'KEY' })
  })

  it('licenses every build inside the range, its lowest and highest included', async () => {
    for (const major of [2, 3]) {
      const h = await harness(null, { major })
      h.setStored({ key: 'KEY', activationId: 'act_1', lease: await rangeLease(h, 3, 2), lastSeen: NOW })
      expect((await h.license.status()).state).toBe('licensed')
    }
  })

  it('reads a lease with no lowest major as starting at 1, as every lease before it did', async () => {
    const h = await harness(null, { major: 1 })
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: await rangeLease(h, 1), lastSeen: NOW })
    expect((await h.license.status()).state).toBe('licensed')
  })

  it('runs any later build on an open-ended key', async () => {
    const h = await harness(null, { major: 41 })
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: await rangeLease(h, OPEN_MAJOR, 2), lastSeen: NOW })
    expect((await h.license.status()).state).toBe('licensed')
  })

  it("maps the server's update-required to outdated on activate", async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'update-required' } }))
    expect(await h.license.activate('KEY')).toEqual({ ok: false, error: 'outdated' })
  })

  it('reports outdated when renewal says update-required', async () => {
    const h = await harness()
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'update-required' } }))

    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'outdated', key: 'KEY' })
  })

  it('keeps a renewed lease that starts above this build, and reports outdated', async () => {
    const h = await harness(null, { major: 1 })
    const expired = await h.sign('KEY', 'perpetual', 3600, NOW - 2 * DAY)
    const fresh = await rangeLease(h, 2, 2)
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))

    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'outdated', key: 'KEY' })
    expect(h.getStored()?.lease).toBe(fresh)
  })
})

describe('upgradeUrl', () => {
  it("names this device's activation on a payment link, for an upgrade sale to find", async () => {
    const h = await harness({ key: 'SLUICE-AAAA-BBBB-CCCC-DDDD', activationId: 'act_device1' })
    const url = await h.license.upgradeUrl('https://buy.stripe.com/test_abc')
    expect(url).toBe('https://buy.stripe.com/test_abc?client_reference_id=act_device1')
  })

  it('never puts the licence key in the URL', async () => {
    // A URL lands in browser history and in the tenant's Stripe session; the
    // activation id grants nothing on its own.
    const h = await harness({ key: 'SLUICE-AAAA-BBBB-CCCC-DDDD', activationId: 'act_device1' })
    const url = await h.license.upgradeUrl('https://buy.stripe.com/test_abc?client_reference_id=x')
    expect(url ?? '').not.toContain('SLUICE')
  })

  it("keeps the link's own parameters, and replaces a client_reference_id already on it", async () => {
    const h = await harness({ key: 'KEY-1', activationId: 'act_1' })
    const url = await h.license.upgradeUrl('https://buy.stripe.com/x?prefilled_email=jo%40example.com&client_reference_id=old')
    const params = new URL(url ?? '').searchParams
    expect(params.get('prefilled_email')).toBe('jo@example.com')
    expect(params.getAll('client_reference_id')).toEqual(['act_1'])
  })

  it('is null on a device holding no activated licence', async () => {
    for (const state of [{ trialStart: NOW }, { key: 'KEY-1' }]) {
      const h = await harness(state)
      expect(await h.license.upgradeUrl('https://buy.stripe.com/test_abc')).toBeNull()
      expect(h.http.calls).toHaveLength(0)
    }
  })
})

describe('upgrade protection: telling the server what this device runs', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'

  /** An open lease (every version), carrying its upgrade window's end when given (ms). */
  async function openLease(h: Awaited<ReturnType<typeof harness>>, windowEnds?: number, now = NOW) {
    return signLease(
      {
        sub: KEY,
        product: PRODUCT,
        aid: 'act_1',
        model: 'perpetual',
        lim: 3,
        major: OPEN_MAJOR,
        ...(windowEnds !== undefined ? { upgradeUntil: Math.floor(windowEnds / 1000) } : {}),
        ent: {},
        ttlSeconds: 30 * 24 * 3600,
      },
      h.signingKey,
      now,
    )
  }

  it('refresh() sends the major it has just noted as kept, in the same validate', async () => {
    const h = await harness(null, { major: 5 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 5, keptMajor: 2, lastSeen: NOW })
    h.http.on('validate', async () => ({ status: 200, json: { lease: await openLease(h, NOW + 10 * DAY) } }))

    expect((await h.license.refresh()).state).toBe('licensed')
    expect(h.http.bodyOf('validate')).toMatchObject({ keptMajor: 5 })
  })

  it('never lands a kept major noted for one activation on another saved meanwhile', async () => {
    // Another instance activates another key while this one judges its lease:
    // the major this run noted (keptMajor) is about the activation it judged.
    let swap = () => {}
    const h = await harness(null, {
      major: 5,
      fingerprint: {
        async get() {
          swap()
          return 'fp-test'
        },
      },
    })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await openLease(h, NOW + 10 * DAY), checkedMajor: 5, lastSeen: NOW })
    const other: StoredState = { key: 'SLUICE-OTHR-OTHR-OTHR-OTHR', activationId: 'act_2', lease: 'theirs', lastSeen: NOW }
    swap = () => {
      swap = () => {}
      h.setStored(other)
    }
    h.http.fail = true

    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()).toMatchObject({ activationId: 'act_2' })
    expect(h.getStored()?.keptMajor).toBeUndefined()
  })

  it('reports a newer major on an open lease online at once, and notes it was heard', async () => {
    const h = await harness(null, { major: 3 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    const fresh = await openLease(h, NOW + 10 * DAY)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))

    expect((await h.license.status()).state).toBe('licensed')
    expect(h.http.bodyOf('validate')).toMatchObject({ key: KEY, major: 3 })
    expect(h.getStored()).toMatchObject({ lease: fresh, checkedMajor: 3 })
  })

  it('keeps the valid open lease, and the app running, when that check cannot reach the server', async () => {
    const h = await harness(null, { major: 3 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    h.http.fail = true

    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.called('validate')).toBe(true)
    expect(h.getStored()).toMatchObject({ lease, checkedMajor: 2 })
  })

  it('notes the run all the same when it cannot be saved: sent with the check, and licensed', async () => {
    const h = await harness(null, { major: 3 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.failWrites()

    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.bodyOf('validate')).toMatchObject({ keptMajor: 3 })
  })

  it('does not ask when the server has already heard this major', async () => {
    const h = await harness(null, { major: 3 })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await openLease(h, NOW + 10 * DAY), checkedMajor: 3, lastSeen: NOW })
    await h.license.status()
    expect(h.http.calls).toHaveLength(0)
  })

  it("notes the major it runs while the lease's window is open, and sends it on the next validate", async () => {
    const h = await harness(null, { major: 3 })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await openLease(h, NOW + 10 * DAY), checkedMajor: 3, lastSeen: NOW })
    await h.license.status()
    expect(h.getStored()?.keptMajor).toBe(3)

    h.http.on('validate', () => ({ status: 503, json: { error: 'unavailable' } }))
    await h.license.refresh()
    expect(h.http.bodyOf('validate')).toMatchObject({ major: 3, keptMajor: 3 })
  })

  it("stops noting at the window's end: a major first run after it is not kept", async () => {
    // The lease, signed in the window, outlives it by days. A build of 4 run after the end was not
    // run inside the protection.
    const h = await harness(null, { major: 4 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 4, keptMajor: 3, lastSeen: NOW })
    h.setClock(NOW + 11 * DAY)
    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()?.keptMajor).toBe(3)
  })

  it("counts the window's last second as closed, and the one before as open", async () => {
    const end = NOW + 10 * DAY // a whole second, as the claim carries it
    for (const [clock, kept] of [
      [end, 3],
      [end - 1000, 4],
    ] as const) {
      const h = await harness(null, { major: 4 })
      h.setStored({ key: KEY, activationId: 'act_1', lease: await openLease(h, end), checkedMajor: 4, keptMajor: 3, lastSeen: NOW })
      h.setClock(clock)
      await h.license.status()
      expect([clock - end, h.getStored()?.keptMajor]).toEqual([clock - end, kept])
    }
  })

  it('notes nothing on a lease that carries no window', async () => {
    const h = await harness(null, { major: 3 })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await openLease(h), checkedMajor: 3, lastSeen: NOW })
    await h.license.status()
    expect(h.getStored()?.keptMajor).toBeUndefined()
  })

  it("starts a key's notes afresh on activate, and drops them on deactivate", async () => {
    const h = await harness({ key: 'OLD-KEY', activationId: 'act_old', keptMajor: 7, checkedMajor: 7 }, { major: 2 })
    const lease = await openLease(h, NOW + 10 * DAY)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    await h.license.activate(KEY)
    expect(h.getStored()).toMatchObject({ key: KEY, checkedMajor: 2, keptMajor: 2 })

    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    await h.license.deactivate()
    expect(h.getStored()?.keptMajor).toBeUndefined()
    expect(h.getStored()?.checkedMajor).toBeUndefined()
  })
})

describe('the check of a newer major: once, bounded, and backing off', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A device on 3 holding a valid open lease, last heard by the server on 2. */
  async function onNewMajor() {
    const h = await harness(null, { major: 3 })
    const lease = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: OPEN_MAJOR, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    return h
  }
  const validates = (h: Awaited<ReturnType<typeof harness>>) => h.http.calls.filter((c) => c.action === 'validate').length

  it.each([
    ['revoked', 'revoked'],
    ['expired', 'revoked'],
    ['deactivated', 'revoked'],
    ['upgrade-required', 'upgrade'],
    ['update-required', 'outdated'],
  ] as const)('records the major as heard on a %s refusal, keeps the refusal, and does not ask again', async (error, reason) => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error } }))
    expect(await h.license.status()).toEqual({ state: 'invalid', reason, key: KEY })
    expect(h.getStored()).toMatchObject({ key: KEY, activationId: 'act_1', checkedMajor: 3, refused: reason })
    expect(await h.license.status()).toEqual({ state: 'invalid', reason, key: KEY })
    expect(validates(h)).toBe(1)
  })

  it.each([['revoked'], ['expired'], ['deactivated']])('drops the lease on a %s verdict, which is about the key', async (error) => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error } }))
    await h.license.status()
    expect(h.getStored()?.lease).toBeUndefined()
    expect(h.getStored()?.refusedMajor).toBeUndefined()
  })

  it.each([
    ['upgrade-required', 'upgrade'],
    ['update-required', 'outdated'],
  ] as const)('keeps the lease on a %s verdict, which is about this build, with the major refused', async (error, reason) => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error } }))
    await h.license.status()
    expect(h.getStored()).toMatchObject({ refused: reason, refusedMajor: 3 })
    expect(h.getStored()?.lease).toBeDefined()
  })

  it('lets a rollback to a covered build run offline after its newer build was refused an upgrade', async () => {
    // v4 is refused (its window ended early); the customer reinstalls v3 and
    // runs it offline: the lease covers 3, and the refusal was about 4.
    const h = await onNewMajor()
    const v4 = h.licenseFor(4)
    h.http.on('validate', () => ({ status: 403, json: { error: 'upgrade-required' } }))
    expect(await v4.status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
    h.http.fail = true
    expect((await h.licenseFor(3).status()).state).toBe('licensed')
    // The same build and a newer one stay refused, offline included.
    expect(await h.licenseFor(4).status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
    expect(await h.licenseFor(5).status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY })
    expect(validates(h)).toBe(1)
  })

  it('lets an update to a covered build run offline after its older build was refused as out of date', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error: 'update-required' } }))
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'outdated', key: KEY })
    h.http.fail = true
    expect(await h.licenseFor(3).status()).toEqual({ state: 'invalid', reason: 'outdated', key: KEY })
    expect((await h.licenseFor(4).status()).state).toBe('licensed')
    expect(await h.licenseFor(2).status()).toEqual({ state: 'invalid', reason: 'outdated', key: KEY })
  })

  it('keeps a cancelled subscriber on a new major refused on this status() and the next, offline included', async () => {
    const h = await harness(null, { major: 3 })
    const lease = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'subscription', lim: 3, major: OPEN_MAJOR, ent: {}, ttlSeconds: 7 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'expired' } }))
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    // The network goes: the lease it held is still within its own life, and it
    // is not read to license the app again.
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
  })

  it('heals a refused key when the server licenses it again, and forgets the refusal', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error: 'expired' } }))
    expect((await h.license.status()).state).toBe('invalid')
    // The customer renews; the next status asked once the wait is over is
    // given a lease.
    h.setClock(NOW + ASK_AGAIN_MS)
    const renewed = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: OPEN_MAJOR, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.http.on('validate', () => ({ status: 200, json: { lease: renewed, activationId: 'act_1' } }))
    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()?.refused).toBeUndefined()
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')
  })

  it('keeps a lease an ambiguous answer comes back on, and records no refusal', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 404, json: { error: 'unknown-product' } }))
    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()?.refused).toBeUndefined()
    expect(h.getStored()?.lease).toBeDefined()
  })

  it('starts afresh on a new activation after a refusal, and on a deactivate', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error: 'deactivated' } }))
    expect((await h.license.status()).state).toBe('invalid')
    const lease = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_2', model: 'perpetual', lim: 3, major: OPEN_MAJOR, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_2' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.getStored()?.refused).toBeUndefined()
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')

    h.setStored({ ...h.getStored(), refused: 'revoked' })
    await h.license.deactivate()
    expect(h.getStored()?.refused).toBeUndefined()
    expect(await h.license.status()).toEqual({ state: 'unlicensed' })
  })

  it('asks a refused key again only once the wait is over, and at once on a refresh()', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    expect((await h.license.status()).state).toBe('invalid')
    expect(validates(h)).toBe(1)
    h.setClock(NOW + ASK_AGAIN_MS - 1)
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(validates(h)).toBe(1)
    expect((await h.license.refresh()).state).toBe('invalid')
    expect(validates(h)).toBe(2)
    // The refresh's refusal starts the wait afresh.
    h.setClock(NOW + ASK_AGAIN_MS - 1 + ASK_AGAIN_MS - 1)
    await h.license.status()
    expect(validates(h)).toBe(2)
    h.setClock(NOW + ASK_AGAIN_MS - 1 + ASK_AGAIN_MS)
    await h.license.status()
    expect(validates(h)).toBe(3)
  })

  it('asks for an expired lease again only once the wait is over, and at once on a refresh()', async () => {
    const h = await harness()
    const expired = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
    expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.setClock(NOW + RETRY_UNANSWERED_MS - 1)
    expect((await h.license.status()).state).toBe('expired')
    expect(validates(h)).toBe(1)
    h.setClock(NOW + RETRY_UNANSWERED_MS)
    await h.license.status()
    expect(validates(h)).toBe(2)
    await h.license.refresh()
    expect(validates(h)).toBe(3)
    // A lease from the server ends the wait.
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW + RETRY_UNANSWERED_MS)
    h.http.fail = false
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))
    expect((await h.license.refresh()).state).toBe('licensed')
    expect(h.getStored()?.backoffSince).toBeUndefined()
  })

  it('serialises overlapping status() calls: one question, and the refusal survives', async () => {
    // Both run on a new major. The first asks and waits on the server; without
    // the lock the second asked too, and wrote back its own stale snapshot
    // after the first's refusal, bringing the dropped lease back.
    const h = await onNewMajor()
    let answer: (value: { status: number; json: unknown }) => void = () => {}
    let asked = 0
    h.http.on('validate', () => {
      asked += 1
      if (asked > 1) return { status: 503, json: { error: 'busy' } }
      return new Promise<{ status: number; json: unknown }>((resolve) => {
        answer = resolve
      })
    })
    const first = h.license.status()
    const second = h.license.status()
    await h.http.whenCalled('validate')
    answer({ status: 403, json: { error: 'revoked' } })
    expect(await first).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(await second).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(asked).toBe(1)
    expect(h.getStored()).toMatchObject({ refused: 'revoked', checkedMajor: 3 })
    expect(h.getStored()?.lease).toBeUndefined()
  })

  it('records the major as heard on an answer it cannot use, and does not ask again', async () => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status: 200, json: { lease: 'not.a.lease' } }))
    expect((await h.license.status()).state).toBe('licensed')
    await h.license.status()
    expect(validates(h)).toBe(1)
    expect(h.getStored()?.checkedMajor).toBe(3)
  })

  it('backs off after no answer, and asks again once the interval has passed', async () => {
    const h = await onNewMajor()
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()).toMatchObject({ checkedMajor: 2, backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.setClock(NOW + RETRY_UNANSWERED_MS - 1)
    await h.license.status()
    expect(validates(h)).toBe(1)
    h.setClock(NOW + RETRY_UNANSWERED_MS)
    await h.license.status()
    expect(validates(h)).toBe(2)
  })

  it.each([[503], [429]])('treats a %i as no verdict, keeps the lease, and waits the hour: the server did answer', async (status) => {
    const h = await onNewMajor()
    h.http.on('validate', () => ({ status, json: { error: 'busy' } }))
    expect((await h.license.status()).state).toBe('licensed')
    expect(h.getStored()).toMatchObject({ checkedMajor: 2, backoffSince: NOW, backoffMs: ASK_AGAIN_MS })
    h.setClock(NOW + RETRY_UNANSWERED_MS)
    await h.license.status()
    expect(validates(h)).toBe(1)
    h.setClock(NOW + ASK_AGAIN_MS)
    await h.license.status()
    expect(validates(h)).toBe(2)
  })

  it("returns the valid lease when the network never answers, after at most the check's bound", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await onNewMajor()
    h.http.hang = true
    let settled = false
    const pending = h.license.status().then((s) => {
      settled = true
      return s
    })
    // The check is out, however long the work before it took.
    await h.http.whenCalled('validate')
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
  })
})

describe('a save that fails once the server has answered', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  // The write is atomic: a failed one left the stored state as it was, and the next call writes
  // again. The answer the server gave stands meanwhile.
  it("is the server's refusal all the same, the stored lease untouched", async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    h.failWrites()
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(h.writes()).toBeGreaterThan(0)
    expect(h.getStored()?.lease).toBe(lease)
  })

  it("is the server's renewal all the same, for a lease that had run out", async () => {
    const h = await harness()
    const old = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: old, checkedMajor: 1, lastSeen: NOW })
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))
    h.failWrites()
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lease).toBe(old)
    // Written by the next call that can.
    h.failWrites(false)
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('is no answer at all, rather than a rejection, when nothing answered either', async () => {
    const h = await harness()
    const old = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: old, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    h.failWrites()
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
  })

  it("is the server's trial all the same, from startTrial()", async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    h.failWrites()
    expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    expect(h.getStored()).toBeNull()
  })

  it('still fails deactivate(), which the customer asked for, the key kept to try again', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    h.failWrites()
    await expect(h.license.deactivate()).rejects.toMatchObject({ code: 'EBUSY' })
    expect(h.getStored()).toMatchObject({ key: KEY, lease })
  })

  it('keeps a trial it could not save for the process, answers it, and saves it once it can', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    h.failWrites()
    expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    // The next status() reads no trial on the disk, and answers the one it holds.
    expect(await h.license.status()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    expect(h.getStored()).toBeNull()

    h.failWrites(false)
    expect(await h.license.status()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
    expect(h.getStored()).toMatchObject({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease })
    // Saved once: not written again by every status() after it.
    const writes = h.writes()
    await h.license.status()
    expect(h.writes()).toBe(writes)
  })

  it('never moves a trial start later when it saves the trial it kept', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    h.failWrites()
    await h.license.startTrial()
    // Meanwhile another instance of the app saved an earlier start.
    h.setStored({ trialStart: NOW - 9 * DAY })
    h.failWrites(false)
    await h.license.status()
    expect(h.getStored()).toMatchObject({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW + 5 * DAY })
  })

  describe('a kept trial, and a newer trial answer another instance saved', () => {
    /**
     * startTrial() asked at NOW, its answer (ending NOW + 5 days) kept unsaved;
     * then another instance saves `theirs`, and writes work again unless `stillFailing`.
     */
    async function keptThen(
      theirs: StoredState | ((h: Awaited<ReturnType<typeof harness>>) => Promise<StoredState>),
      stillFailing = false,
    ) {
      const h = await harness()
      const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
      h.failWrites()
      expect(await h.license.startTrial()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
      h.setStored(typeof theirs === 'function' ? await theirs(h) : theirs)
      h.failWrites(stillFailing)
      return h
    }

    it("never makes the trial longer: the newer answer's earlier end stands", async () => {
      const h = await keptThen({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY, trialAt: NOW + 1 })
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
      expect(h.getStored()).toMatchObject({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY, trialAt: NOW + 1 })
    })

    it("answers the newer answer's end while its own still cannot be saved", async () => {
      const h = await keptThen({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY, trialAt: NOW + 1 }, true)
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
    })

    it("takes the newer answer's later end too: a trial the server extended", async () => {
      const h = await keptThen(async (x) => ({
        trialStart: NOW - 9 * DAY,
        trialEndsAt: NOW + 20 * DAY,
        // The answer the other instance had came with a lease signed to the new end.
        trialLease: await x.sign('trial:fp-test', 'trial', 20 * 24 * 3600),
        trialAt: NOW + 1,
      }))
      expect(await h.license.status()).toMatchObject({ state: 'trial', trialDaysLeft: 20 })
      expect(h.getStored()).toMatchObject({ trialEndsAt: NOW + 20 * DAY })
    })

    it('wins over a stored trial with no stamp', async () => {
      const h = await keptThen({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW - 2 * DAY })
      expect(await h.license.status()).toMatchObject({ state: 'trial', trialDaysLeft: 5 })
      expect(h.getStored()).toMatchObject({ trialStart: NOW - 9 * DAY, trialEndsAt: NOW + 5 * DAY, trialAt: NOW })
    })

    it.each([
      ['a deactivate', { trialStart: NOW - 9 * DAY }],
      ["another key's activation", { key: 'SLUICE-BBBB-BBBB-BBBB-BBBB', activationId: 'act_2', lease: 'LB', checkedMajor: 1 }],
    ])('saves its trial after %s, the licence as that left it', async (_case, theirs: StoredState) => {
      const h = await keptThen(theirs)
      await h.license.status()
      const stored = h.getStored()
      expect(stored).toMatchObject({ ...theirs, trialStart: theirs.trialStart ?? NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialAt: NOW })
      expect(stored?.key).toBe(theirs.key)
    })
  })

  it('still fails activate(), which the customer asked for and can try again', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.failWrites()
    await expect(h.license.activate(KEY)).rejects.toMatchObject({ code: 'EBUSY' })
  })
})

describe('the waits, early renewal, bounded calls and the clock guard', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  const validates = (h: Awaited<ReturnType<typeof harness>>) => h.http.calls.filter((c) => c.action === 'validate').length
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<[string, (h: Awaited<ReturnType<typeof harness>>) => Promise<StoredState>]>([
    ['a stored refusal', async () => ({ key: KEY, activationId: 'act_1', refused: 'revoked' })],
    ['a lease past its end', async (h) => ({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY), checkedMajor: 1 })],
    [
      'a valid lease near its end',
      async (h) => ({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW - 26 * DAY), checkedMajor: 1 }),
    ],
  ])('times the wait before asking again by the device clock, not the guard: %s', async (_case, stored) => {
    // The guard (lastSeen) is a day ahead of the device clock, and the last ask
    // was half an hour ago by the device clock: its hour's wait is not over,
    // though by the guard it would be.
    const h = await harness()
    h.setStored({ ...(await stored(h)), backoffSince: NOW - 30 * 60_000, backoffMs: ASK_AGAIN_MS, lastSeen: NOW + DAY })
    h.http.fail = true
    await h.license.status()
    expect(h.http.called('validate')).toBe(false)
  })

  it('starts the wait after a renewal by the device clock, not the guard', async () => {
    const h = await harness()
    const expired = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, checkedMajor: 1, lastSeen: NOW + DAY })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
    expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
  })

  it("licenses from a renewal whose check of the server's time cannot read the state just then", async () => {
    // The renewal reads the state again to bring the clock guard to the server's time (engine.ts
    // `serverNow`): a read that fails there costs the correction, never the renewal, and status()
    // still answers.
    const h = await harness()
    const expired = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, checkedMajor: 1, lastSeen: NOW })
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh } }))
    // The status's own read is the first; the renewal's check of the time, the second.
    h.failRead(2)
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lease).toBe(fresh)
  })

  it('heals a lease that ran out offline within the short wait once the network is back', async () => {
    const h = await harness()
    const expired = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
    // Back online a moment later: the next status() after the short wait heals.
    h.http.fail = false
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))
    h.setClock(NOW + RETRY_UNANSWERED_MS - 1)
    expect((await h.license.status()).state).toBe('expired')
    h.setClock(NOW + RETRY_UNANSWERED_MS)
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('still waits the hour after a refusal, the short wait notwithstanding', async () => {
    const h = await harness()
    const expired = await h.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    expect((await h.license.status()).reason).toBe('revoked')
    h.setClock(NOW + RETRY_UNANSWERED_MS)
    await h.license.status()
    expect(validates(h)).toBe(1)
    h.setClock(NOW + ASK_AGAIN_MS)
    await h.license.status()
    expect(validates(h)).toBe(2)
  })

  it('renews a lease early once it is within RENEW_WITHIN_MS of its end, and not before', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    const renewed = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW + 30 * DAY - RENEW_WITHIN_MS)
    h.http.on('validate', () => ({ status: 200, json: { lease: renewed, activationId: 'act_1' } }))
    h.setClock(NOW + 30 * DAY - RENEW_WITHIN_MS - 1)
    expect((await h.license.status()).state).toBe('licensed')
    expect(validates(h)).toBe(0)
    h.setClock(NOW + 30 * DAY - RENEW_WITHIN_MS + 1)
    expect((await h.license.status()).state).toBe('licensed')
    expect(validates(h)).toBe(1)
    expect(h.getStored()?.lease).toBe(renewed)
    // The renewed lease is far from its end: no ask on the next status().
    await h.license.status()
    expect(validates(h)).toBe(1)
  })

  it('renews a short lease at half its life, not on every status()', async () => {
    const h = await harness()
    const week = await h.sign(KEY, 'subscription', 7 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease: week, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    h.setClock(NOW + 3.5 * DAY - 1)
    await h.license.status()
    expect(validates(h)).toBe(0)
    h.setClock(NOW + 3.5 * DAY + 1)
    await h.license.status()
    expect(validates(h)).toBe(1)
  })

  it('keeps the valid lease when an early renewal gets nothing, and waits before trying again', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    const at = NOW + 25 * DAY
    h.setClock(at)
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()).toMatchObject({ lease, backoffSince: at, backoffMs: RETRY_UNANSWERED_MS })
    await h.license.status()
    expect(validates(h)).toBe(1)
  })

  it('answers a refusal to an early renewal: the server no longer stands behind the lease', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'subscription', 7 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'expired' } }))
    h.setClock(NOW + 5 * DAY)
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
  })

  it('bounds a call whose adapter never settles, so the calls behind it still answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.hang = true
    const refreshed = h.license.refresh()
    const later = h.license.status()
    await h.http.whenCalled('validate')
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS)
    expect(await refreshed).toEqual({ state: 'licensed', key: KEY })
    expect(await later).toEqual({ state: 'licensed', key: KEY })
  })

  it('bounds every request by the configured httpTimeoutMs when the call names none', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(null, { httpTimeoutMs: 2_000 })
    h.http.hang = true
    let result: unknown
    const activating = h.license.activate(KEY).then((r) => (result = r))
    await h.http.whenCalled('activate')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await activating
    expect(result).toEqual({ ok: false, error: 'network' })
  })

  it('lets a later call go ahead when one is stuck on an adapter the SDK does not bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.hangNextRead()
    void h.license.status()
    let answered: unknown
    const later = h.license.status().then((s) => (answered = s))
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000 - 1)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await later
    // Answered from storage behind the stuck call, and saying so.
    expect(answered).toEqual({ state: 'licensed', key: KEY, stalled: true })
  })

  it('licenses again online after a clock that jumped 60 days ahead is put right', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW - DAY)
    // The clock jumped; a status() then raised the guard to it; the clock is
    // put right. The guard still reads 60 days on: the lease looks expired.
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW + 60 * DAY })
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lastSeen).toBe(NOW)
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('stamps an activation and a deactivation with their time, as answers to an ask', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    await h.license.activate(KEY)
    expect(h.getStored()?.verdictAt).toBe(NOW)
    h.setClock(NOW + DAY)
    await h.license.deactivate()
    expect(h.getStored()?.verdictAt).toBe(NOW + DAY)
  })

  it('stamps by the guarded clock: never earlier than the last time seen, with the clock put back', async () => {
    const h = await harness({ lastSeen: NOW + 5 * 60_000 })
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    await h.license.activate(KEY)
    expect(h.getStored()?.verdictAt).toBe(NOW + 5 * 60_000)
    h.setClock(NOW - DAY)
    await h.license.deactivate()
    expect(h.getStored()?.verdictAt).toBe(NOW + 5 * 60_000)
    await h.license.startTrial()
    expect(h.getStored()?.trialAt).toBe(NOW + 5 * 60_000)
  })

  it('saves its own answers after the clock is put back: one process never supersedes itself', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW - DAY)
    // The last answer was stamped by a clock 60 days ahead, since put right.
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW, verdictAt: NOW + 60 * DAY })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(h.getStored()).toMatchObject({ refused: 'revoked', verdictAt: NOW })
    expect(h.getStored()?.lease).toBeUndefined()
  })

  it("licenses from the server's lease when the guard it puts right cannot be saved", async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW - DAY)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW + 60 * DAY })
    const fresh = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: fresh, activationId: 'act_1' } }))
    h.failWrites()
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(h.getStored()?.lastSeen).toBe(NOW + 60 * DAY)
  })

  /** The guard after a refresh() answered with a fresh lease signed at NOW, the clock at `clock`. */
  async function guardAfterRefresh(guard: number, clock = NOW) {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: guard })
    h.setClock(clock)
    h.http.on('validate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect((await h.license.refresh()).state).toBe('licensed')
    return h.getStored()?.lastSeen
  }

  it('leaves the guard where it is for a fresh lease within the tolerance of it', async () => {
    expect(await guardAfterRefresh(NOW + 30 * 60_000)).toBe(NOW + 30 * 60_000)
    // Exactly at the tolerance is still within it.
    expect(await guardAfterRefresh(NOW + CLOCK_TOLERANCE_MS)).toBe(NOW + CLOCK_TOLERANCE_MS)
  })

  it('brings the guard back for a fresh lease signed 1 ms past the tolerance before it', async () => {
    expect(await guardAfterRefresh(NOW + CLOCK_TOLERANCE_MS + 1)).toBe(NOW)
  })

  it("brings the guard back to the lease's signing time, not to a device clock behind it", async () => {
    expect(await guardAfterRefresh(NOW + 60 * DAY, NOW - 2 * 60 * 60_000)).toBe(NOW)
  })

  it('brings the guard back for a lease naming the key in another case, as the server matches it', async () => {
    const h = await harness()
    const held = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease: held, checkedMajor: 1, lastSeen: NOW + 60 * DAY })
    const answer = await h.sign('Sluice-aaaa-BBBB-CCCC-DDDD', 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: answer, activationId: 'act_1' } }))
    await h.license.refresh()
    expect(h.getStored()?.lastSeen).toBe(NOW)
  })

  it.each([
    ['another key', { sub: 'SLUICE-OTHR-OTHR-OTHR-OTHR', aid: 'act_1', at: NOW }],
    ['another activation', { sub: KEY, aid: 'act_2', at: NOW }],
    ['a lease older than the one the device holds', { sub: KEY, aid: 'act_1', at: NOW - DAY }],
  ])('moves no guard for a lease signed for %s', async (_case, signed) => {
    const h = await harness()
    const held = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease: held, checkedMajor: 1, lastSeen: NOW + 60 * DAY })
    const answer = await signLease(
      { sub: signed.sub, product: PRODUCT, aid: signed.aid, model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      signed.at,
    )
    h.http.on('validate', () => ({ status: 200, json: { lease: answer, activationId: signed.aid } }))
    await h.license.refresh()
    expect(h.getStored()?.lastSeen).toBe(NOW + 60 * DAY)
  })

  it('lets no call go ahead behind a stuck one with a write a late stale write could revert', async () => {
    // A's refusal is written, and its write is held inside the adapter with the
    // whole state A was handed. B goes ahead after the grace: it answers from
    // what is stored, with no ask and no write. When A's write lands, nothing
    // newer was there for it to revert; the next call asks again as usual.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    const release = h.holdNextWrite()
    const a = h.license.refresh()
    await h.http.whenCalled('validate')
    const renewed = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.http.on('validate', () => ({ status: 200, json: { lease: renewed, activationId: 'act_1' } }))
    let b: unknown
    const later = h.license.refresh().then((s) => (b = s))
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    await later
    // Read-only: the lease still stored, licensed; not asked, nothing written.
    expect(b).toEqual({ state: 'licensed', key: KEY, stalled: true })
    expect(validates(h)).toBe(1)
    // The one write so far is A's, still held: B wrote nothing.
    expect(h.writes()).toBe(1)
    expect(h.getStored()?.lease).toBe(lease)
    release()
    expect(await a).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    expect(h.getStored()).toMatchObject({ refused: 'revoked' })
    // A settled: the next call writes again, and heals.
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect(validates(h)).toBe(2)
  })

  /**
   * A refresh() whose refusal write is held inside the adapter, and time past
   * the grace: whatever is called now runs read-only behind it.
   */
  async function behindAStuckCall(stored: (h: Awaited<ReturnType<typeof harness>>) => Promise<StoredState>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    h.setStored(await stored(h))
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    h.holdNextWrite()
    void h.license.refresh()
    await h.whenWritten(1)
    expect(h.writes()).toBe(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    return h
  }

  /** How many calls of `action` were made. */
  const posts = (h: Awaited<ReturnType<typeof harness>>, action: string) => h.http.calls.filter((c) => c.action === action).length

  const licensed = async (h: Awaited<ReturnType<typeof harness>>): Promise<StoredState> => ({
    key: KEY,
    activationId: 'act_1',
    lease: await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW),
    checkedMajor: 1,
    lastSeen: NOW,
  })

  it('times the grace from when the stuck call started, however late the next is queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW), checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    h.holdNextWrite()
    void h.license.refresh()
    await h.whenWritten(1)
    // 20 s into the stuck call, the next is queued: it goes ahead 10 s later,
    // when the stuck call's grace is up, not 30 s after it was queued.
    await vi.advanceTimersByTimeAsync(20_000)
    let answered: unknown
    const later = h.license.status().then((v) => (answered = v))
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000 - 20_000 - 1)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await later
    expect(answered).toEqual({ state: 'licensed', key: KEY, stalled: true })
  })

  it('answers activate() network behind a stuck call: no request, no write', async () => {
    const h = await behindAStuckCall(licensed)
    expect(await h.license.activate(KEY)).toEqual({ ok: false, error: 'network' })
    expect(posts(h, 'activate')).toBe(0)
    expect(h.writes()).toBe(1)
  })

  it('rejects deactivate() behind a stuck call: no request, and the key still stored', async () => {
    const h = await behindAStuckCall(licensed)
    await expect(h.license.deactivate()).rejects.toThrow()
    expect(posts(h, 'deactivate')).toBe(0)
    expect(h.getStored()?.key).toBe(KEY)
    expect(h.writes()).toBe(1)
  })

  it('answers startTrial() with the stored trial behind a stuck call: no request, no write', async () => {
    const h = await behindAStuckCall(async (x) => ({
      ...(await licensed(x)),
      trialStart: NOW,
      trialEndsAt: NOW + 5 * DAY,
      trialLease: await x.sign('trial:fp-test', 'trial', 5 * 24 * 3600),
    }))
    expect(await h.license.startTrial()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5, stalled: true })
    expect(posts(h, 'trial')).toBe(0)
    expect(h.writes()).toBe(1)
  })

  it('answers startTrial() behind a stuck call without asking for a trial whose lease does not verify', async () => {
    // A trial lease signed with a key the product rotated from: a status() would
    // ask for the trial again (`healTrial`), but nothing read-only asks.
    const rotatedKey = await harness()
    const h = await behindAStuckCall(async (x) => ({
      ...(await licensed(x)),
      trialStart: NOW,
      trialEndsAt: NOW + 5 * DAY,
      trialLease: await rotatedKey.sign('trial:fp-test', 'trial', 5 * 24 * 3600),
    }))
    h.http.on('trial', async () => ({
      status: 200,
      json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY, lease: await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600) },
    }))
    expect(await h.license.startTrial()).toEqual({ state: 'expired', reason: 'trial', stalled: true })
    expect(posts(h, 'trial')).toBe(0)
    expect(h.writes()).toBe(1)
  })

  it('answers a stored refusal behind a stuck call, without asking', async () => {
    const h = await behindAStuckCall(async () => ({ key: KEY, activationId: 'act_1', refused: 'revoked', lastSeen: NOW }))
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY, stalled: true })
    expect(posts(h, 'validate')).toBe(1)
  })

  it('answers an expired stored lease as expired offline behind a stuck call, without asking', async () => {
    const h = await behindAStuckCall(async (x) => ({
      key: KEY,
      activationId: 'act_1',
      lease: await x.sign(KEY, 'perpetual', 3600, NOW - 2 * DAY),
      lastSeen: NOW,
    }))
    expect(await h.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY, stalled: true })
    expect(posts(h, 'validate')).toBe(1)
  })

  it('runs three calls queued at once on a slow network one after another, each asking', async () => {
    // Each answer takes 40 s, inside a 60 s bound. Timed from when they were
    // queued, the third would have gone ahead at 75 s while the second was
    // still asking; timed from when the second started, it waits for it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(null, { httpTimeoutMs: 60_000 })
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    let inFlight = 0
    let most = 0
    h.http.on('validate', () => {
      inFlight += 1
      most = Math.max(most, inFlight)
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight -= 1
          resolve({ status: 200, json: { lease, activationId: 'act_1' } })
        }, 40_000),
      )
    })
    const calls = [h.license.refresh(), h.license.refresh(), h.license.refresh()]
    const all = Promise.all(calls)
    // Time moves only while an answer is awaited: between answers, each call's
    // own work (storage, signature checks, the device hash on the thread pool)
    // runs to its request first, however long that takes on a busy box.
    for (let asked = 1; asked <= calls.length; asked++) {
      await Promise.race([h.http.whenCalled('validate', asked), all])
      await vi.advanceTimersByTimeAsync(40_000)
    }
    for (const call of calls) expect(await call).toEqual({ state: 'licensed', key: KEY })
    expect(validates(h)).toBe(3)
    expect(most).toBe(1)
  })
})

describe('a lease held to its key, its activation and its device', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  const validates = (h: Awaited<ReturnType<typeof harness>>) => h.http.calls.filter((c) => c.action === 'validate').length

  /** A 30-day licence lease, for this device unless told otherwise (the harness fingerprint is 'fp-test'). */
  async function leaseFor(h: Awaited<ReturnType<typeof harness>>, over: { sub?: string; aid?: string; device?: string | null } = {}) {
    const device = over.device === undefined ? 'fp-test' : over.device
    return signLease(
      {
        sub: over.sub ?? KEY,
        product: PRODUCT,
        aid: over.aid ?? 'act_1',
        // A seat keyed by a machine id: the only kind held to its device.
        ...(device === null ? {} : { fp: await fingerprintClaim(device), fpk: 'machine' as const }),
        model: 'perpetual',
        lim: 3,
        major: 1,
        ent: {},
        ttlSeconds: 30 * 24 * 3600,
      },
      h.signingKey,
      NOW,
    )
  }

  describe("deactivate, when the activation stored is another device's", () => {
    // A profile copied or restored from another PC carries that PC's activation: releasing it would
    // lock that PC out at its next check-in.
    it("drops it here without releasing that device's seat", async () => {
      const h = await harness()
      h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, { device: 'fp-other-pc' }), checkedMajor: 1, lastSeen: NOW })
      h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))

      expect(await h.license.deactivate()).toEqual({ released: true })
      expect(h.http.called('deactivate')).toBe(false)
      expect(h.getStored()?.key).toBeUndefined()
    })

    it('reads whose seat it is from a lease that has run out too', async () => {
      const h = await harness()
      const expired = await signLease(
        {
          sub: KEY,
          product: PRODUCT,
          aid: 'act_1',
          fp: await fingerprintClaim('fp-other-pc'),
          fpk: 'machine',
          model: 'perpetual',
          lim: 3,
          major: 1,
          ent: {},
          ttlSeconds: 30 * 24 * 3600,
        },
        h.signingKey,
        NOW - 40 * DAY,
      )
      h.setStored({ key: KEY, activationId: 'act_1', lease: expired, checkedMajor: 1, lastSeen: NOW })

      expect(await h.license.deactivate()).toEqual({ released: true })
      expect(h.http.called('deactivate')).toBe(false)
    })

    it('takes a device refusal that stands for this device as the same', async () => {
      const h = await harness()
      const own = await fingerprintClaim('fp-test')
      h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h), refused: 'device', refusedFor: [own], checkedMajor: 1, lastSeen: NOW })

      expect(await h.license.deactivate()).toEqual({ released: true })
      expect(h.http.called('deactivate')).toBe(false)
    })

    it("still releases this device's own seat, and one held to no machine", async () => {
      for (const device of ['fp-test', null]) {
        const h = await harness()
        h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, { device }), checkedMajor: 1, lastSeen: NOW })
        h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))

        expect(await h.license.deactivate()).toEqual({ released: true })
        expect(h.http.called('deactivate')).toBe(true)
      }
    })
  })

  it('licenses this device on its own lease, offline', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(validates(h)).toBe(0)
  })

  it('takes a lease with no device claim, which its renewal brings', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, { device: null }), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')
  })

  it('matches the key without regard to case, as the server does', async () => {
    const h = await harness()
    const lease = await leaseFor(h, { sub: 'Sluice-aaaa-BBBB-CCCC-DDDD' })
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')
  })

  it.each([
    ['another key', { sub: 'SLUICE-OTHR-OTHR-OTHR-OTHR' }, { state: 'invalid', reason: 'tampered' }],
    ['another activation', { aid: 'act_2' }, { state: 'invalid', reason: 'tampered' }],
    [
      'another device (a machine that changed, or a licence file copied from it)',
      { device: 'fp-another-machine' },
      { state: 'invalid', reason: 'device', key: KEY },
    ],
  ])('refuses offline a lease for %s, and asks the server under the usual waits', async (_case, over, refused) => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, over), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual(refused)
    expect(validates(h)).toBe(1)
    expect(await h.license.status()).toEqual(refused)
    expect(validates(h)).toBe(1)
  })

  it("stays refused for another device even online: the server renews the other device's lease", async () => {
    const h = await harness()
    const theirs = await leaseFor(h, { device: 'fp-another-machine' })
    h.setStored({ key: KEY, activationId: 'act_1', lease: theirs, checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 200, json: { lease: theirs, activationId: 'act_1' } }))
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
  })

  it("says device, offline too, once a lease with no device claim is renewed with another device's", async () => {
    // A licence file copied while it held a lease with no `fp`: taken until its renewal, which
    // brings the other machine's claim.
    const h = await harness()
    const before = await leaseFor(h, { device: null })
    h.setStored({ key: KEY, activationId: 'act_1', lease: before, checkedMajor: 1, lastSeen: NOW })
    const theirs = await leaseFor(h, { device: 'fp-another-machine' })
    h.http.on('validate', () => ({ status: 200, json: { lease: theirs, activationId: 'act_1' } }))
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
  })

  it('accepts the lease an activation of this device is given, and refuses one for another device', async () => {
    const h = await harness()
    const mine = await leaseFor(h)
    h.http.on('activate', () => ({ status: 200, json: { lease: mine, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })

    const other = await harness()
    const elsewhere = await leaseFor(other, { device: 'fp-another-machine' })
    other.http.on('activate', () => ({ status: 200, json: { lease: elsewhere, activationId: 'act_1' } }))
    expect(await other.license.activate(KEY)).toEqual({ ok: false, error: 'invalid-lease' })
  })
})

describe('who this device is, when it cannot be told', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  const REG_OUTPUT = `\r\n    MachineGuid    REG_SZ    ${GUID}\r\n`
  const MACHINE = hashFingerprint(`machine-id|${GUID}`)
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A Windows machine whose registry read never finishes the first `hangs` times, then answers. */
  function slowRegistry(hangs: number): MachineIdSource & { stuck: Stuck } {
    let left = hangs
    const stuck = stuckCalls()
    return {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      run: () => {
        if (left > 0) {
          left -= 1
          return stuck.hang<string>()
        }
        return Promise.resolve(REG_OUTPUT)
      },
      readFile: async () => '',
      stuck,
    }
  }

  /** A licence lease for this key and activation, its seat keyed (`kind`) by the fingerprint `device`. */
  async function leaseFor(
    h: Awaited<ReturnType<typeof harness>>,
    device: string,
    kind: 'machine' | 'hostname' = 'machine',
    sub = KEY,
  ) {
    return signLease(
      { sub, product: PRODUCT, aid: 'act_1', fp: await fingerprintClaim(device), fpk: kind, model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
  }

  /**
   * `work` run to its answer under fake timers. Each time it is stuck on a read
   * that never answers (`stuck`), the next timer, that read's bound, is let
   * fire, and only then: the work between runs however long it takes on a busy
   * machine, and no bound fires early.
   */
  async function settle<T>(work: Promise<T>, stuck: Stuck = stuckCalls()): Promise<T> {
    let done = false
    const finished = work.then(
      () => {
        done = true
      },
      () => {
        done = true
      },
    )
    for (let next = stuck.count() + 1; !done; next++) {
      await Promise.race([finished, stuck.when(next)])
      if (!done) await vi.advanceTimersToNextTimerAsync()
    }
    return work
  }

  it('does not call a slow first read another device: no flip on a normal run, then the id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const source = slowRegistry(1)
    const first = await harness(null, { fingerprint: nodeFingerprinter(source) })
    const lease = await leaseFor(first, MACHINE)
    first.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    first.http.fail = true
    // The read outlives its time box: this run cannot tell, and does not judge.
    expect(await settle(first.license.status(), source.stuck)).toEqual({ state: 'licensed', key: KEY })
    // Another fingerprinter on the same machine, whose read answers: the id.
    const second = await harness(null, { fingerprint: nodeFingerprinter(source) })
    second.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(second, MACHINE), checkedMajor: 1, lastSeen: NOW })
    second.http.fail = true
    expect(await settle(second.license.status(), source.stuck)).toEqual({ state: 'licensed', key: KEY })
  })

  it('waits the full activation bound on a read that does not finish, not the 2 s a status() gets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const source = slowRegistry(1)
    const h = await harness(null, { fingerprint: nodeFingerprinter(source) })
    let settled = false
    void h.license.activate(KEY).then(() => (settled = true))
    await source.stuck.when(1)
    await vi.advanceTimersByTimeAsync(MACHINE_ID_TIMEOUT_MS + 1_500)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(ACTIVATE_MACHINE_ID_TIMEOUT_MS - 1_000 - (MACHINE_ID_TIMEOUT_MS + 1_500))
    expect(settled).toBe(false)
    expect(h.http.called('activate')).toBe(false)
  })

  it('activates under the host name when the machine id never reads in time, and moves to the id once it does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const source = slowRegistry(1)
    const h = await harness(null, { fingerprint: nodeFingerprinter(source) })
    h.http.on('activate', async () => ({
      status: 200,
      json: { lease: await leaseFor(h, hostnameFingerprint(), 'hostname'), activationId: 'act_1' },
    }))
    expect(await settle(h.license.activate(KEY), source.stuck)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ fingerprint: hostnameFingerprint(), fingerprintKind: 'hostname' })
    expect(h.getStored()?.deviceKind).toBe('hostname')
    // The id reads now: the renewal sends it first, as a machine id, for the server to re-key the
    // seat to it, and the install is keyed by it.
    h.http.on('validate', async () => ({ status: 200, json: { lease: await leaseFor(h, MACHINE), activationId: 'act_1' } }))
    expect(await settle(h.license.refresh(), source.stuck)).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.bodyOf('validate')).toMatchObject({ fingerprints: [MACHINE, hostnameFingerprint()], fingerprintKind: 'machine' })
    expect(h.getStored()?.deviceKind).toBe('machine')
  })

  it('never re-activates the seat a machine id keyed under the host name: network, to retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const source = slowRegistry(1)
    const h = await harness(null, { fingerprint: nodeFingerprinter(source) })
    h.setStored({ key: KEY, activationId: 'act_1', deviceKind: 'machine', lastSeen: NOW })
    expect(await settle(h.license.activate(KEY), source.stuck)).toEqual({ ok: false, error: 'network' })
    expect(h.http.called('activate')).toBe(false)
  })

  it('takes a lease from an activation under the host-name fingerprint, and renews it', async () => {
    const h = await harness(null, { fingerprint: nodeFingerprinter(slowRegistry(0)) })
    const legacy = await leaseFor(h, hostnameFingerprint(), 'hostname')
    h.setStored({ key: KEY, activationId: 'act_1', lease: legacy, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    // Renewed after the app updated: the server signs the fingerprint it was
    // activated with, and is told both this device answers to.
    h.http.fail = false
    h.http.on('validate', () => ({ status: 200, json: { lease: legacy, activationId: 'act_1' } }))
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect((h.http.bodyOf('validate') as { fingerprints?: string[] }).fingerprints).toEqual([MACHINE, hostnameFingerprint()])
  })

  it('does not judge the device, nor tell the server who it is, on a run that cannot tell', async () => {
    let calls = 0
    const failing: Fingerprinter = {
      async get() {
        calls += 1
        throw new Error('fingerprint adapter failed')
      },
    }
    const h = await harness(null, { fingerprint: failing })
    const elsewhere = await leaseFor(h, 'fp-another-machine')
    h.setStored({ key: KEY, activationId: 'act_1', lease: elsewhere, checkedMajor: 1, lastSeen: NOW })
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    h.http.on('validate', () => ({ status: 200, json: { lease: elsewhere, activationId: 'act_1' } }))
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.bodyOf('validate')).not.toHaveProperty('fingerprints')
    // Not kept: every call asks the adapter again.
    expect(calls).toBeGreaterThan(1)
  })

  it('reads again after an adapter that failed, and judges the device once it can tell', async () => {
    let failing = true
    const flaky: Fingerprinter = {
      async get() {
        if (failing) throw new Error('not yet')
        return 'fp-test'
      },
    }
    const h = await harness(null, { fingerprint: flaky })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, 'fp-another-machine'), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect((await h.license.status()).state).toBe('licensed')
    failing = false
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
  })

  it('bounds an adapter that never answers, and does not keep that', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stuck = stuckCalls()
    const hanging: Fingerprinter = { get: () => stuck.hang<string>() }
    const h = await harness(null, { fingerprint: hanging })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, 'fp-test'), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    let answered: unknown
    const pending = h.license.status().then((v) => (answered = v))
    await stuck.when(1)
    await vi.advanceTimersByTimeAsync(MACHINE_ID_TIMEOUT_MS - 1)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(answered).toEqual({ state: 'licensed', key: KEY })
    await settle(h.license.status(), stuck)
    expect(stuck.count()).toBe(2)
  })

  it("takes the server's device refusal: another machine holding this seat's licence file", async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, 'fp-test'), checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'device' } }))
    expect(await h.license.refresh()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
    expect(h.http.bodyOf('validate')).toMatchObject({ fingerprints: ['fp-test'] })
    // A custom `get()` says nothing of what it hashes: no kind is claimed for it.
    expect(h.http.bodyOf('validate')).not.toHaveProperty('fingerprintKind')
    // Kept: the offline `fp` check already stops a copied lease. Refused for
    // this device only.
    expect(h.getStored()).toMatchObject({ refused: 'device', refusedFor: [await fingerprintClaim('fp-test')] })
    expect(h.getStored()?.lease).toBeDefined()
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'invalid', reason: 'device', key: KEY })
  })

  it('licenses again at once when the fingerprint flips back after a device refusal', async () => {
    let fingerprint = 'fp-flipped'
    const flipping: Fingerprinter = {
      async get() {
        return fingerprint
      },
    }
    const h = await harness(null, { fingerprint: flipping })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, 'fp-test'), checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'device' } }))
    expect((await h.license.refresh()).reason).toBe('device')
    // The next run reads the device as it was: the refusal was not for it.
    fingerprint = 'fp-test'
    const next = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, fingerprint: flipping } })
    h.http.fail = true
    expect(await next.status()).toEqual({ state: 'licensed', key: KEY })
  })

  /** A Windows machine whose `reg` runs and exits non-zero: no id to read (an endpoint tool blocking it, say). */
  function blockedRegistry(): MachineIdSource {
    return {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      run: () => Promise.reject(Object.assign(new Error('reg exited 1'), { code: 1 })),
      readFile: async () => '',
    }
  }

  it('does not refuse a machine-keyed install whose id stops reading, and keeps its lease', async () => {
    // The id worked here (`deviceKind`); now `reg` exits non-zero. That says
    // nothing about the machine changing: cannot tell, never the host name.
    const h = await harness(null, { fingerprint: nodeFingerprinter(blockedRegistry()) })
    const lease = await leaseFor(h, MACHINE)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, deviceKind: 'machine', lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    h.http.fail = false
    h.http.on('validate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.bodyOf('validate')).not.toHaveProperty('fingerprints')
    expect(h.getStored()).toMatchObject({ lease, deviceKind: 'machine' })
  })

  it.each([
    ['renamed: the machine id reads now', slowRegistry(0)],
    ['renamed, with no id to read either', blockedRegistry()],
  ])('does not refuse a host-name-keyed seat: %s', async (_case, source) => {
    const h = await harness(null, { fingerprint: nodeFingerprinter(source) })
    // Activated under a host name this machine no longer has (renamed, or an
    // x64 build under Rosetta moved to arm64).
    const lease = await leaseFor(h, hashFingerprint('old-name|darwin|x64'), 'hostname')
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it("does not judge a lease whose seat's kind is unknown (no `fpk`): every seat until it is re-keyed", async () => {
    // A seat of unknown kind carries `fp` and no `fpk` until a check-in re-keys it to a machine
    // id.
    const h = await harness(null, { fingerprint: nodeFingerprinter(slowRegistry(0)) })
    const lease = await signLease(
      {
        sub: KEY,
        product: PRODUCT,
        aid: 'act_1',
        fp: await fingerprintClaim(hashFingerprint('old-name|darwin|x64')),
        model: 'perpetual',
        lim: 3,
        major: 1,
        ent: {},
        ttlSeconds: 30 * 24 * 3600,
      },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('holds nothing to its device with deviceHold false: no kind sent, no lease judged by its device', async () => {
    // A product on non-persistent, pooled VDI: every session may be another machine.
    const h = await harness(null, { fingerprint: nodeFingerprinter(slowRegistry(0)), deviceHold: false })
    h.http.on('activate', async () => ({ status: 200, json: { lease: await leaseFor(h, MACHINE), activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ fingerprint: MACHINE })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('fingerprintKind')
    expect(h.getStored()?.deviceKind).toBeUndefined()
    // A machine-keyed lease for another machine: not judged.
    const elsewhere = await leaseFor(h, 'fp-another-machine')
    h.setStored({ key: KEY, activationId: 'act_1', lease: elsewhere, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
    // And the server is told no fingerprints to check.
    h.http.fail = false
    h.http.on('validate', () => ({ status: 200, json: { lease: elsewhere, activationId: 'act_1' } }))
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: KEY })
    expect(h.http.bodyOf('validate')).not.toHaveProperty('fingerprints')
    expect(h.http.bodyOf('validate')).not.toHaveProperty('fingerprintKind')
  })

  it('activates under the host name with deviceHold false on an install a machine id once keyed, its id unreadable', async () => {
    // Nothing is held, so install memory has no say: the host name is its fingerprint.
    const h = await harness(null, { fingerprint: nodeFingerprinter(blockedRegistry()), deviceHold: false })
    // The seat this install holds, re-activated: install memory would refuse
    // the host name here, were anything held.
    h.setStored({ key: KEY, activationId: 'act_1', deviceKind: 'machine', lastSeen: NOW })
    h.http.on('activate', async () => ({ status: 200, json: { lease: await leaseFor(h, MACHINE), activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ fingerprint: hostnameFingerprint() })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('fingerprintKind')
    // It writes the kind it used, none: the stored machine kind is cleared.
    expect(h.getStored()?.deviceKind).toBeUndefined()
    // And a machine-keyed lease stays licensed in that state.
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('clears a stored machine kind when a fingerprint of unknown kind activates the seat (a custom get())', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', deviceKind: 'machine', lastSeen: NOW })
    h.http.on('activate', async () => ({ status: 200, json: { lease: await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW), activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.getStored()?.deviceKind).toBeUndefined()
  })

  it('keeps to the seat whatever case its key was stored in: re-activating it answers network', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(null, { fingerprint: nodeFingerprinter(blockedRegistry()) })
    h.setStored({ key: KEY.toLowerCase(), activationId: 'act_1', deviceKind: 'machine', lastSeen: NOW })
    expect(await settle(h.license.activate(KEY))).toEqual({ ok: false, error: 'network' })
    expect(h.http.called('activate')).toBe(false)
  })

  it('activates under the host name after a deactivate frees a machine install whose id no longer reads', async () => {
    // Install memory protects the seat it holds; with none, the next activation is free of it.
    const h = await harness(null, { fingerprint: nodeFingerprinter(blockedRegistry()) })
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h, MACHINE), checkedMajor: 1, deviceKind: 'machine', lastSeen: NOW })
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    await h.license.deactivate()
    expect(h.getStored()?.deviceKind).toBeUndefined()
    h.http.on('activate', async () => ({
      status: 200,
      json: { lease: await leaseFor(h, hostnameFingerprint(), 'hostname'), activationId: 'act_1' },
    }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ fingerprint: hostnameFingerprint(), fingerprintKind: 'hostname' })
    expect(h.getStored()?.deviceKind).toBe('hostname')
  })

  it('activates another key under the host name on a machine install whose id no longer reads', async () => {
    const h = await harness(null, { fingerprint: nodeFingerprinter(blockedRegistry()) })
    h.setStored({ key: 'SLUICE-OLDK-OLDK-OLDK-OLDK', activationId: 'act_1', deviceKind: 'machine', lastSeen: NOW })
    h.http.on('activate', async () => ({
      status: 200,
      json: { lease: await leaseFor(h, hostnameFingerprint(), 'hostname'), activationId: 'act_1' },
    }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ fingerprint: hostnameFingerprint(), fingerprintKind: 'hostname' })
  })

  it('does not stand a device refusal on a later run that only shares its host-name alternate', async () => {
    // Boot 1 is refused `device`. Boot 2 reads another machine id (a transient
    // one, say) but has the same host name: the refusal was for boot 1's own id.
    const HOST = 'fp-same-host'
    let own = 'fp-boot-1'
    const booting: Fingerprinter = {
      get: async () => own,
      identify: async () => ({ fingerprint: own, kind: 'machine', alternates: [HOST] }),
    }
    const h = await harness(null, { fingerprint: booting })
    // A lease whose seat's kind is unknown: not itself judged by its device.
    const lease = await h.sign(KEY, 'perpetual', 30 * 24 * 3600, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'device' } }))
    expect((await h.license.refresh()).reason).toBe('device')
    expect(h.getStored()?.refusedFor).toEqual([await fingerprintClaim('fp-boot-1')])
    own = 'fp-boot-2'
    const next = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, fingerprint: booting } })
    h.http.fail = true
    expect(await next.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('takes a trial lease started under the host name it answers to besides its machine id', async () => {
    const h = await harness(null, { fingerprint: nodeFingerprinter(slowRegistry(0)) })
    const claim = await fingerprintClaim(hostnameFingerprint())
    const trialLease = await signLease(
      { sub: `trial:${claim}`, product: PRODUCT, aid: claim, fpk: 'machine', model: 'trial', lim: 1, major: OPEN_MAJOR, ent: {}, ttlSeconds: 7 * 24 * 3600 },
      h.signingKey,
      NOW,
    )
    h.setStored({ trialStart: NOW - 2 * DAY, trialLease, lastSeen: NOW }) // no trialEndsAt
    expect((await h.license.status()).state).toBe('trial')
  })

  it('starts no trial on a run that cannot tell who the device is', async () => {
    const failing: Fingerprinter = {
      async get() {
        throw new Error('fingerprint adapter failed')
      },
    }
    const h = await harness(null, { fingerprint: failing })
    await h.license.startTrial()
    expect(h.http.called('trial')).toBe(false)
  })

  describe('a trial lease, held to its device', () => {
    async function trialLease(h: Awaited<ReturnType<typeof harness>>, device: string, kind: 'machine' | 'hostname' = 'machine') {
      const claim = await fingerprintClaim(device)
      return signLease(
        { sub: `trial:${claim}`, product: PRODUCT, aid: claim, fpk: kind, model: 'trial', lim: 1, major: OPEN_MAJOR, ent: {}, ttlSeconds: 7 * 24 * 3600 },
        h.signingKey,
        NOW,
      )
    }

    it("runs the trial on this device's lease", async () => {
      const h = await harness()
      h.setStored({ trialStart: NOW, trialLease: await trialLease(h, 'fp-test'), lastSeen: NOW })
      expect((await h.license.status()).state).toBe('trial')
    })

    it("does not run it on another device's lease", async () => {
      const h = await harness()
      h.setStored({ trialStart: NOW - 30 * DAY, trialLease: await trialLease(h, 'fp-another-machine'), lastSeen: NOW })
      expect(await h.license.status()).toEqual({ state: 'expired', reason: 'trial' })
    })

    it('runs it on a lease started under a host name, whatever device it names: a host name is not held', async () => {
      const h = await harness()
      h.setStored({ trialStart: NOW - 30 * DAY, trialLease: await trialLease(h, 'fp-another-machine', 'hostname'), lastSeen: NOW })
      expect((await h.license.status()).state).toBe('trial')
    })

    it('does not judge it on a run that cannot tell', async () => {
      const failing: Fingerprinter = {
        async get() {
          throw new Error('fingerprint adapter failed')
        },
      }
      const h = await harness(null, { fingerprint: failing })
      h.setStored({ trialStart: NOW, trialLease: await trialLease(h, 'fp-another-machine'), lastSeen: NOW })
      expect((await h.license.status()).state).toBe('trial')
    })
  })
})
