import { describe, it, expect, vi, afterEach } from 'vitest'
import { OPEN_MAJOR, fingerprintClaim, signLease } from '@keygrant/shared'
import { MAX_PENDING_SPENDS } from './meters.js'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from './offline.js'
import { DEFAULT_HTTP_TIMEOUT_MS } from './adapters.js'
import { NOW, PRODUCT, harness, type Harness } from './license.fixture.js'
import { KEY, METERS, entry, holding, journalOf, meteredLease, offlineFileWithMet, rawLease, spent, useBody } from './meters.fixture.js'
import { FILE_LICENSED } from './license-file.fixture.js'

/**
 * The journal of unsynced spends is reported with the next validate, `use` and `deactivate`, dropped only when
 * the server confirms it, and never costs a customer a renewal or a release (the SDK contract, 12.2 and 12.4).
 */

const MINUTE = 60_000
const HOUR = 3_600_000
const LONG_AGO = NOW - 2 * HOUR

afterEach(() => {
  vi.useRealTimers()
})

/** The `spends` a validate request carried. */
const reported = (h: Harness, nth = 0): unknown => (h.http.calls.filter((c) => c.action === 'validate')[nth]?.body as { spends?: unknown }).spends

/** A renewal's answer: the lease the harness's key signs for the key, and the confirmations the server names. */
async function renewal(h: Harness, spends?: unknown) {
  return { status: 200, json: { lease: await meteredLease(h), ...(spends !== undefined ? { spends } : {}) } }
}

describe('what a validate reports', () => {
  it('carries the journal, oldest first, a void marked, and no spends at all when there is none', async () => {
    const h = await holding(METERS, {
      spends: [
        entry({ id: 'A'.repeat(22), n: 3, at: NOW - 3000, kind: 'offline' }),
        entry({ id: 'B'.repeat(22), n: 1, at: NOW - 2000, kind: 'unanswered' }),
        entry({ id: 'C'.repeat(22), n: 2, at: NOW - 1000, kind: 'void' }),
      ],
    })
    h.http.on('validate', async () => renewal(h))
    await h.license.refresh()
    expect(reported(h)).toEqual([
      { id: 'A'.repeat(22), meter: 'exports', n: 3, at: NOW - 3000 },
      { id: 'B'.repeat(22), meter: 'exports', n: 1, at: NOW - 2000 },
      { id: 'C'.repeat(22), meter: 'exports', n: 2, at: NOW - 1000, void: true },
    ])
    const bare = await holding()
    bare.http.on('validate', async () => renewal(bare))
    await bare.license.refresh()
    expect(bare.http.bodyOf('validate')).not.toHaveProperty('spends')
  })

  it('reports only what is valid of a stored journal, and renews all the same', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 2 }), { id: 4 }, null, 'x', entry({ id: 'Z'.repeat(22), n: 0 })] as never })
    h.http.on('validate', async () => renewal(h))
    expect(await h.license.refresh()).toMatchObject({ state: 'licensed' })
    expect(reported(h)).toHaveLength(1)
    const junk = await holding(METERS, { spends: { not: 'a list' } as never })
    junk.http.on('validate', async () => renewal(junk))
    expect(await junk.license.refresh()).toMatchObject({ state: 'licensed' })
    expect(junk.http.bodyOf('validate')).not.toHaveProperty('spends')
  })

  it('renews with a journal that is full', async () => {
    const full = Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: String(i).padStart(22, 'q'), meter: `m${i}`, kind: 'unanswered', at: LONG_AGO }))
    const h = await holding(METERS, { spends: full })
    h.http.on('validate', async () => renewal(h))
    expect(await h.license.refresh()).toMatchObject({ state: 'licensed' })
    expect(reported(h)).toHaveLength(MAX_PENDING_SPENDS)
  })

  it('drops exactly the entries the answer names as recorded', async () => {
    const h = await holding(METERS, {
      spends: [
        entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO, kind: 'unanswered' }),
        entry({ id: 'B'.repeat(22), n: 5, at: LONG_AGO, kind: 'offline', meter: 'renders' }),
        entry({ id: 'C'.repeat(22), n: 1, at: LONG_AGO, kind: 'void' }),
        entry({ id: 'D'.repeat(22), n: 1, at: LONG_AGO, kind: 'void', meter: 'renders' }),
      ],
    })
    h.http.on('validate', async () =>
      renewal(h, [
        { id: 'A'.repeat(22), n: 3 },
        // More recorded than ever held: dropped. Less than held: kept.
        { id: 'B'.repeat(22), n: 4 },
        // A void is named void; a count for a void entry does not name it.
        { id: 'C'.repeat(22), void: true },
        { id: 'D'.repeat(22), n: 1 },
        // Another shape confirms nothing, and an id the journal has not is nothing.
        { id: 'E'.repeat(22), n: 1 },
        { n: 2 },
        'x',
        null,
      ]),
    )
    await h.license.refresh()
    expect(journalOf(h).map((e) => e.id)).toEqual(['B'.repeat(22), 'D'.repeat(22)])
  })

  it('keeps an offline entry another process grew meanwhile, with its count', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO, kind: 'offline' })] })
    h.http.on('validate', async () => {
      // Another process spent two more while this request was out.
      h.setStored({ ...h.getStored(), spends: [entry({ id: 'A'.repeat(22), n: 5, at: LONG_AGO, kind: 'offline' })] })
      return renewal(h, [{ id: 'A'.repeat(22), n: 3 }])
    })
    await h.license.refresh()
    expect(journalOf(h)).toEqual([entry({ id: 'A'.repeat(22), n: 5, at: LONG_AGO, kind: 'offline' })])
  })

  it('drops nothing when the answer names nothing, and waits an hour before status() offers it again', async () => {
    const h = await holding(METERS, { spends: [entry({ at: LONG_AGO })] })
    h.http.on('validate', async () => renewal(h))
    await h.license.refresh()
    expect(journalOf(h)).toHaveLength(1)
    expect(h.getStored()).toMatchObject({ backoffMs: ASK_AGAIN_MS })
    // A valid, far lease with a journal asks only once the wait is over.
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
    h.setClock(NOW + HOUR)
    await h.license.status()
    expect(h.http.count('validate')).toBe(2)
  })

  it('drops nothing on a 5xx or 429, whatever their body says, and nothing on no answer', async () => {
    for (const answer of [{ status: 503, json: { spends: [{ id: 'A'.repeat(22), n: 3 }] } }, { status: 429, json: { spends: [{ id: 'A'.repeat(22), n: 3 }] } }, null]) {
      const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO })] })
      if (answer === null) h.http.fail = true
      else h.http.on('validate', () => answer)
      await h.license.refresh()
      expect(journalOf(h), JSON.stringify(answer)).toHaveLength(1)
    }
  })

  it('drops what a refusal confirms, whatever its status', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO })] })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked', spends: [{ id: 'A'.repeat(22), n: 3 }] } }))
    expect(await h.license.refresh()).toMatchObject({ state: 'invalid', reason: 'revoked' })
    expect(journalOf(h)).toEqual([])
    // A 200 without a lease is an answer too.
    const g = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO })] })
    g.http.on('validate', () => ({ status: 200, json: { spends: [{ id: 'A'.repeat(22), n: 3 }] } }))
    await g.license.refresh()
    expect(journalOf(g)).toEqual([])
  })

  it('keeps the confirmation in memory when it cannot be saved, so the entry is not reported again, and saves it next', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO })] })
    h.http.on('validate', async () => renewal(h, [{ id: 'A'.repeat(22), n: 3 }]))
    h.failWrites(true)
    await h.license.refresh()
    expect(journalOf(h)).toHaveLength(1)
    expect((await h.license.status()).meters?.exports?.unsynced).toBe(0)
    await h.license.refresh()
    expect(reported(h, 1)).toBeUndefined()
    h.failWrites(false)
    await h.license.status()
    expect(journalOf(h)).toEqual([])
  })

  it('reports to a valid lease at the next status(), once its own wait is not running, and not before', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 1, at: NOW - 30_000, kind: 'unanswered' })] })
    h.http.on('validate', async () => renewal(h, [{ id: 'A'.repeat(22), n: 1 }]))
    // The journal's wait: a minute after one unanswered spend.
    await h.license.status()
    expect(h.http.count('validate')).toBe(0)
    h.setClock(NOW - 30_000 + MINUTE)
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
    expect(journalOf(h)).toEqual([])
    // Nothing left to report: a valid, far lease asks nothing.
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
  })

  it('reports an offline-only journal at once, and waits for the ask’s own wait after a request that got no answer', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 2, at: NOW, kind: 'offline' })] })
    h.http.fail = true
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
    expect(h.getStored()).toMatchObject({ backoffMs: RETRY_UNANSWERED_MS })
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
    h.http.fail = false
    h.http.on('validate', async () => renewal(h, [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', n: 2 }]))
    h.setClock(NOW + MINUTE)
    await h.license.status()
    expect(journalOf(h)).toEqual([])
  })

  it('asks of a lease past its end, to heal it, with the journal', async () => {
    const h = await holding(METERS, { spends: [entry({ at: NOW - 40 * 86_400_000, kind: 'offline' })] })
    h.setClock(NOW + 40 * 86_400_000)
    h.http.on('validate', async () => renewal(h))
    await h.license.status()
    expect(reported(h)).toHaveLength(1)
  })

  it('rides a use request too, and is dropped by what that request confirms', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 2, at: LONG_AGO, kind: 'unanswered' })] })
    h.http.on('use', () => ({ status: 200, json: { ...(spent(87).json as object), spends: [{ id: 'A'.repeat(22), n: 2 }] } }))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 87 })
    const body = h.http.bodyOf('use') as { spends: unknown[] }
    expect(body.spends).toEqual([{ id: 'A'.repeat(22), meter: 'exports', n: 2, at: LONG_AGO }])
    expect(journalOf(h)).toEqual([])
  })
})

describe('what a deactivate reports', () => {
  it('carries the journal with the device’s fingerprints, then clears it with the rest of the licence', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 2 }), entry({ id: 'B'.repeat(22), kind: 'void' })] })
    h.http.on('deactivate', () => ({ status: 200, json: { ok: true } }))
    expect(await h.license.deactivate()).toEqual({ released: true })
    const body = h.http.bodyOf('deactivate') as Record<string, unknown>
    expect(body).toMatchObject({ key: KEY, activationId: 'act_1' })
    expect(body.spends).toHaveLength(2)
    expect(body.fingerprints).toHaveLength(1)
    expect(h.getStored()).not.toHaveProperty('spends')
    expect(h.getStored()).not.toHaveProperty('meterFigures')
    expect(h.getStored()?.key).toBeUndefined()
    expect(h.getStored()?.activationId).toBeUndefined()
  })

  it('sends exactly the key and the activation when there is nothing to report, as it always did', async () => {
    const h = await holding(METERS, { meterFigures: { exports: { left: 5, total: 100, offline: 10, resets: false, at: NOW } } })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    await h.license.deactivate()
    expect(h.http.bodyOf('deactivate')).toEqual({ key: KEY, activationId: 'act_1' })
    expect(h.getStored()).not.toHaveProperty('meterFigures')
  })

  it('names no fingerprints when it cannot tell who the device is, and the server holds it to none', async () => {
    const h = await holding(METERS, { spends: [entry()] }, { fingerprint: { get: () => Promise.reject(new Error('no id')) } })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    await h.license.deactivate()
    const body = h.http.bodyOf('deactivate') as Record<string, unknown>
    expect(body.spends).toHaveLength(1)
    expect(body).not.toHaveProperty('fingerprints')
  })

  it('clears the journal locally and says the seat may be held when the release got no 200', async () => {
    for (const fail of [true, false]) {
      const h = await holding(METERS, { spends: [entry()] })
      if (fail) h.http.fail = true
      else h.http.on('deactivate', () => ({ status: 503, json: {} }))
      expect(await h.license.deactivate()).toEqual({ released: false })
      expect(h.getStored()).not.toHaveProperty('spends')
    }
  })

  it('reports what this process could not save, and forgets it with the rest', async () => {
    const h = await holding()
    h.http.fail = true
    h.failWrites(true)
    await h.license.use('exports')
    h.failWrites(false)
    h.http.fail = false
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    await h.license.deactivate()
    expect((h.http.bodyOf('deactivate') as { spends: unknown[] }).spends).toHaveLength(1)
    // Nothing of it comes back with the next licence.
    const lease = await meteredLease(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    await h.license.activate(KEY)
    expect((await h.license.status()).meters?.exports?.unsynced).toBe(0)
    expect(journalOf(h)).toEqual([])
    expect(h.getStored()).not.toHaveProperty('spends')
  })

  it('reports nothing for a seat that is another device’s: the release is not its to make', async () => {
    const h = await holding(METERS, { spends: [entry()] })
    // Its lease is held to a machine this one is not: a state file copied from another PC.
    h.setStored({ ...h.getStored(), lease: await rawLease(h, METERS, { fp: 'f'.repeat(64), fpk: 'machine' }) })
    expect(await h.license.deactivate()).toEqual({ released: true })
    expect(h.http.count('deactivate')).toBe(0)
  })
})

describe('status().meters', () => {
  it('shows each meter of the lease with its figures, and nothing when the lease has none', async () => {
    const h = await holding()
    expect(await h.license.status()).toEqual({
      state: 'licensed',
      key: KEY,
      meters: {
        exports: { left: 90, total: 100, offline: 10, unsynced: 0, resets: false },
        renders: { left: 5, total: 5, offline: 0, unsynced: 0, resets: true },
      },
    })
    expect(h.http.count('validate')).toBe(0)
    const bare = await holding(null)
    expect(await bare.license.status()).toEqual({ state: 'licensed', key: KEY })
    expect(await bare.license.status()).not.toHaveProperty('meters')
  })

  it('is net of the unsynced spends of each kind, never below 0, and counts no void', async () => {
    const h = await holding(METERS, {
      spends: [entry({ n: 4, kind: 'offline' }), entry({ id: 'B'.repeat(22), n: 3, kind: 'unanswered' }), entry({ id: 'C'.repeat(22), n: 50, kind: 'void' }), entry({ id: 'D'.repeat(22), n: 9, meter: 'renders' })],
      backoffSince: NOW,
      backoffMs: RETRY_UNANSWERED_MS,
    })
    const { meters } = await h.license.status()
    expect(meters?.exports).toEqual({ left: 83, total: 100, offline: 10, unsynced: 7, resets: false })
    expect(meters?.renders).toEqual({ left: 0, total: 5, offline: 0, unsynced: 9, resets: true })
  })

  it('works behind a call that has not finished, saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await holding(METERS, { spends: [entry({ n: 2 })], lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    h.holdNextWrite()
    void h.license.refresh()
    await h.whenWritten(1)
    const later = h.license.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toMatchObject({ state: 'licensed', stalled: true, meters: { exports: { left: 88, unsynced: 2 } } })
  })

  it('spends behind a call that has not finished: asks, saves nothing of the answer, and keeps the spend in memory', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await holding(METERS, { lastSeen: NOW })
    h.http.on('validate', () => ({ status: 403, json: { error: 'revoked' } }))
    const release = h.holdNextWrite()
    const refreshing = h.license.refresh()
    await h.whenWritten(1)
    const writes = h.writes()
    h.http.on('use', () => spent(89))
    const first = h.license.use('exports')
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await first).toEqual({ ok: true, left: 89 })
    expect(h.http.count('use')).toBe(1)
    // Offline now: the spend is kept in memory and counts.
    h.http.fail = true
    const second = h.license.use('exports', 2)
    await vi.advanceTimersByTimeAsync(0)
    // The answer the first call was given was not saved either, so the lease's own figure is the base.
    expect(await second).toEqual({ ok: true, left: 88, offline: true })
    expect(h.writes()).toBe(writes)
    release()
    // The call that was stuck finishes with its verdict, and the spend kept in memory lands beside it.
    await refreshing
    expect(h.getStored()?.refused).toBe('revoked')
    await h.license.status()
    // The second call was asked (no wait ran) and got no answer: its spend is in doubt, and kept.
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['unanswered', 2]])
  })

  it('is absent on every status but a key’s licensed one: expired, invalid, a trial, a file, none', async () => {
    const expired = await holding()
    expired.setClock(NOW + 40 * 86_400_000)
    expect(await expired.license.status()).toEqual({ state: 'expired', reason: 'offline', key: KEY })
    const revoked = await holding(METERS, { refused: 'revoked' })
    expect(await revoked.license.status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    const none = await harness()
    expect(await none.license.status()).toEqual({ state: 'unlicensed' })
  })

  it('is absent on a trial whose lease carries meters, and on an offline licence file that does', async () => {
    const trial = await harness()
    const lease = await rawLease(trial, METERS, { sub: 'trial:abc', aid: await fingerprintClaim('fp-test'), model: 'trial' })
    trial.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * 86_400_000, lease } }))
    const started = await trial.license.startTrial()
    expect(started.state).toBe('trial')
    expect(started).not.toHaveProperty('meters')
    expect(await trial.license.status()).not.toHaveProperty('meters')

    const file = await holding()
    expect((await file.license.importLicenseFile(await offlineFileWithMet(file, METERS))).ok).toBe(true)
    // The file answers before the key beside it, and a file has no meters, so neither has the status or a spend.
    expect(await file.license.status()).toEqual(FILE_LICENSED)
    expect(await file.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })
  })

  it('keeps a copy of its own in each status', async () => {
    const h = await holding()
    const a = await h.license.status()
    const b = await h.license.status()
    expect(a.meters).not.toBe(b.meters)
    expect(Object.isFrozen(a.meters)).toBe(true)
    expect(Object.isFrozen(a.meters?.exports)).toBe(true)
  })

  it('shows a meter named __proto__ or like an Object.prototype member as a meter like any other', async () => {
    const met = JSON.parse('{"__proto__":{"left":1,"total":2,"offline":0},"constructor":{"left":3,"total":3,"offline":1}}')
    const h = await holding()
    const lease = await rawLease(h, met)
    h.setStored({ key: KEY, activationId: 'act_1', lease })
    const { meters } = await h.license.status()
    expect(Object.keys(meters ?? {}).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(meters ?? {}, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(meters)).toBe(Object.prototype)
  })

  it('takes a figure a use answer gave in place of the lease’s, until the lease is renewed', async () => {
    const h = await holding(METERS, { meterFigures: { exports: { left: 40, total: 100, offline: 10, resets: false, at: NOW + 1000 } } })
    expect((await h.license.status()).meters?.exports).toMatchObject({ left: 40 })
    // A figure from before the lease's own second is older than it; from the same second, newer.
    const older = await holding(METERS, { meterFigures: { exports: { left: 40, total: 100, offline: 10, resets: false, at: NOW - 1000 } } })
    expect((await older.license.status()).meters?.exports).toMatchObject({ left: 90 })
    const same = await holding(METERS, { meterFigures: { exports: { left: 40, total: 100, offline: 10, resets: false, at: NOW } } })
    expect((await same.license.status()).meters?.exports).toMatchObject({ left: 40 })
  })

  it('shows a renewal’s meters, net of the journal after what the answer confirmed', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), n: 2, at: LONG_AGO }), entry({ id: 'B'.repeat(22), n: 1, at: LONG_AGO, kind: 'void' })] })
    const lease = await meteredLease(h, { exports: { left: 70, total: 100, offline: 10 } }, { now: NOW + 5000 })
    h.http.on('validate', () => ({ status: 200, json: { lease, spends: [{ id: 'A'.repeat(22), n: 2 }] } }))
    h.setClock(NOW + 5000)
    expect((await h.license.refresh()).meters).toEqual({ exports: { left: 70, total: 100, offline: 10, unsynced: 0, resets: false } })
  })

  it('stops showing a meter the newest lease no longer names', async () => {
    const h = await holding(METERS, { meterFigures: { renders: { left: 1, total: 5, offline: 0, resets: true, at: NOW - 5000 } } })
    const lease = await meteredLease(h, { exports: { left: 70, total: 100, offline: 10 } }, { now: NOW })
    h.setStored({ ...h.getStored(), lease })
    expect(Object.keys((await h.license.status()).meters ?? {})).toEqual(['exports'])
  })
})

describe('open leases', () => {
  it('spends on an open-ended lease as on any other', async () => {
    const h = await harness()
    const lease = await signLease({ sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: OPEN_MAJOR, ent: {}, met: METERS, ttlSeconds: 86_400 * 30 }, h.signingKey, NOW)
    h.setStored({ key: KEY, activationId: 'act_1', lease })
    h.http.on('use', () => spent(89))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89 })
  })
})

describe('an entry the server did not confirm', () => {
  const held = entry({ id: 'A'.repeat(22), n: 3, at: LONG_AGO, kind: 'offline' })
  const report = { id: held.id, meter: held.meter, n: held.n, at: held.at }
  const unconfirming: [string, (h: Harness) => void][] = [
    ['a lease naming nothing', (h) => h.http.on('validate', async () => renewal(h))],
    ['a 503', (h) => h.http.on('validate', () => ({ status: 503, json: { error: 'down' } }))],
    ['a 429', (h) => h.http.on('validate', () => ({ status: 429, json: { error: 'rate-limited' } }))],
    ['no answer at all', (h) => { h.http.fail = true }],
    ['a count lower than the entry holds', (h) => h.http.on('validate', async () => renewal(h, [{ id: held.id, n: 2 }]))],
  ]

  it.each(unconfirming)('is reported again, with the same id, meter, count and time, after %s', async (_, answer) => {
    const h = await holding(METERS, { spends: [held] })
    answer(h)
    await h.license.refresh()
    expect(journalOf(h)).toEqual([held])
    // Past every wait, the next validate and the next use carry it as it was.
    h.http.fail = false
    h.setClock(NOW + 2 * HOUR)
    h.http.on('validate', async () => renewal(h))
    await h.license.refresh()
    expect(reported(h, h.http.count('validate') - 1)).toEqual([report])
    h.http.on('use', () => spent(89))
    await h.license.use('exports')
    expect((useBody(h) as { spends?: unknown }).spends).toEqual([report])
  })

  it('carries the id a failed use sent into the next request’s report', async () => {
    const h = await holding()
    h.http.fail = true
    await h.license.use('exports', 2)
    const sent = useBody(h).id
    h.http.fail = false
    h.setClock(NOW + 2 * MINUTE)
    h.http.on('validate', async () => renewal(h))
    await h.license.refresh()
    expect(reported(h)).toEqual([{ id: sent, meter: 'exports', n: 2, at: NOW }])
    h.http.on('use', () => spent(89))
    await h.license.use('exports')
    expect((useBody(h, 1) as { spends: { id: string }[] }).spends[0]?.id).toBe(sent)
  })
})

describe('a request that carries no report', () => {
  it('sends no spends with an activation or a trial, though the journal holds some', async () => {
    const h = await holding(METERS, { spends: [entry({ at: LONG_AGO })] })
    const lease = await meteredLease(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    await h.license.startTrial()
    expect(h.http.count('trial')).toBe(1)
    expect(h.http.bodyOf('activate')).not.toHaveProperty('spends')
    expect(h.http.bodyOf('trial')).not.toHaveProperty('spends')
  })
})

describe('a full journal', () => {
  it('refuses a spend the allowance covers, though the request was sent, and appends no void it has no room for', async () => {
    const full = Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: String(i).padStart(22, 'q'), meter: `m${i}`, kind: 'unanswered', at: LONG_AGO }))
    const h = await holding(METERS, { spends: full })
    h.http.fail = true
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 90 })
    expect(h.http.count('use')).toBe(1)
    expect(journalOf(h)).toHaveLength(MAX_PENDING_SPENDS)
    expect(journalOf(h).some((e) => e.kind === 'void')).toBe(false)
  })
})
