import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_MAJOR, signLease } from '@keygrant/shared'
import { License } from './license.js'
import { DEFAULT_HTTP_TIMEOUT_MS, createFileStorage } from './adapters.js'
import { nodeFs, type StorageFs } from './storage-fs.js'
import { MAX_METER_USES, MAX_PENDING_SPENDS, MAX_PENDING_VOIDS, USE_TIMEOUT_MS, newSpendId } from './meters.js'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from './offline.js'
import { NOW, PRODUCT, harness } from './license.fixture.js'
import type { StoredState, UseResult } from './types.js'
import { KEY, METERS, entry, holding, journalOf, meteredLease, spent, useBody } from './meters.fixture.js'

/**
 * `use(meter, n)` (the SDK contract, section 12): exact online, from the offline allowance when the server gives
 * no answer, with the unsynced spends kept in the stored state and reported by the next request that can carry them.
 */

const MINUTE = 60_000

afterEach(() => {
  vi.useRealTimers()
})
/** Long enough ago that the journal's wait for an entry is over. */
const LONG_AGO = NOW - 2 * 3_600_000

describe('use online', () => {
  it('spends exactly, sending the key, the seat, the meter, the amount and a fresh id, and saves the figures it was given', async () => {
    const h = await holding()
    h.http.on('use', () => spent(89, NOW + 1))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89 })
    const body = useBody(h)
    expect(body).toMatchObject({ key: KEY, activationId: 'act_1', meter: 'exports', n: 1, major: 1 })
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.kids).toHaveLength(1)
    expect(body.fingerprints).toHaveLength(1)
    expect(body).not.toHaveProperty('spends')
    expect(body).not.toHaveProperty('keptMajor')
    expect(h.getStored()?.meterFigures).toEqual({ exports: { left: 89, total: 100, offline: 10, resets: false, at: NOW + 1 } })
    expect(journalOf(h)).toEqual([])
  })

  it('spends a batch whole, in one request', async () => {
    const h = await holding()
    h.http.on('use', () => spent(50))
    expect(await h.license.use('exports', 40)).toEqual({ ok: true, left: 50 })
    expect(useBody(h).n).toBe(40)
    expect(h.http.count('use')).toBe(1)
  })

  it('makes a new id for each call: two calls are two spends', async () => {
    const h = await holding()
    h.http.on('use', () => spent(89))
    await h.license.use('exports')
    await h.license.use('exports')
    expect(useBody(h, 0).id).not.toBe(useBody(h, 1).id)
  })

  it('answers from the figure the server gave, net of what this device has not reported', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 3 })] })
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { exports: { left: 80, total: 100, offline: 10 } }, at: NOW } }))
    // The server's 80 does not count the 3 unreported, so 77 is what the customer has.
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 77 })
  })

  it('answers from the base figures as they were when the server gave none for the meter', async () => {
    const h = await holding()
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: {}, at: NOW } }))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 90 })
    h.http.on('use', () => ({ status: 200, json: { spent: true } }))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 90 })
  })

  it('keeps a figure the lease is newer than only until the lease is renewed', async () => {
    const h = await holding()
    h.http.on('use', () => spent(70, NOW + 5_000))
    await h.license.use('exports')
    expect((await h.license.status()).meters?.exports?.left).toBe(70)
    // A renewal brings a lease signed after that figure, whose own figures win.
    const renewed = await meteredLease(h, { exports: { left: 60, total: 100, offline: 10 } }, { now: NOW + 10_000 })
    h.http.on('validate', () => ({ status: 200, json: { lease: renewed } }))
    h.setClock(NOW + 10_000)
    expect((await h.license.refresh()).meters?.exports?.left).toBe(60)
    expect((await h.license.status()).meters?.exports?.left).toBe(60)
  })

  it('answers used-up with what the server says is left, saves the figures and the reports it confirms, and spends nothing offline after', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'BBBBBBBBBBBBBBBBBBBBBB', n: 2, kind: 'unanswered', at: LONG_AGO })] }, {})
    h.http.on('use', () => ({
      status: 409,
      json: { error: 'used-up', left: 1, meters: { exports: { left: 1, total: 100, offline: 10 } }, spends: [{ id: 'BBBBBBBBBBBBBBBBBBBBBB', n: 2 }], at: NOW },
    }))
    expect(await h.license.use('exports', 5)).toEqual({ ok: false, error: 'used-up', left: 1 })
    expect(journalOf(h)).toEqual([])
    expect(h.getStored()?.meterFigures?.exports).toMatchObject({ left: 1, at: NOW })
    // The server's word stands offline too: one is left, and a spend of two is past it.
    h.http.fail = true
    h.setClock(NOW + 2 * MINUTE)
    expect(await h.license.use('exports', 2)).toEqual({ ok: false, error: 'offline-limit', left: 1 })
  })

  it('answers used-up with no left when the answer gave none', async () => {
    const h = await holding()
    h.http.on('use', () => ({ status: 409, json: { error: 'used-up' } }))
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'used-up' })
  })

  it('reads the server’s words on any status but a 200, a 5xx and a 429', async () => {
    const h = await holding()
    h.http.on('use', () => ({ status: 400, json: { error: 'used-up', left: 0 } }))
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'used-up', left: 0 })
    h.http.on('use', () => ({ status: 200, json: { error: 'used-up', left: 0 } }))
    // A 200 is a spend only with spent: true; anything else is no answer.
    expect(await h.license.use('exports')).toMatchObject({ ok: true, offline: true })
  })

  it('answers no-meter for a meter the server does not know, and confirms the reports it carried', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'CCCCCCCCCCCCCCCCCCCCCC', n: 1, kind: 'unanswered', at: LONG_AGO })] })
    h.http.on('use', () => ({ status: 404, json: { error: 'unknown-meter', spends: [{ id: 'CCCCCCCCCCCCCCCCCCCCCC', n: 1 }] } }))
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'no-meter' })
    expect(journalOf(h)).toEqual([])
  })

  it('stores a verdict as a validate’s, and answers it as status() will', async () => {
    const cases = [
      ['revoked', 'revoked'],
      ['expired', 'revoked'],
      ['deactivated', 'revoked'],
      ['upgrade-required', 'upgrade'],
      ['update-required', 'outdated'],
      ['device', 'device'],
    ] as const
    for (const [word, refusal] of cases) {
      const h = await holding()
      h.http.on('use', () => ({ status: 403, json: { error: word } }))
      expect(await h.license.use('exports'), word).toEqual({ ok: false, error: refusal })
      expect(h.getStored()?.refused, word).toBe(refusal)
      expect(await h.license.status(), word).toMatchObject({ state: 'invalid', reason: refusal })
      // The refusal stands: the next spend is not licensed, and asks nothing.
      expect(await h.license.use('exports'), word).toEqual({ ok: false, error: 'not-licensed' })
      expect(h.http.count('use'), word).toBe(1)
    }
  })

  it('records the reports a verdict confirms', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'DDDDDDDDDDDDDDDDDDDDDD', kind: 'void', at: LONG_AGO })] })
    h.http.on('use', () => ({ status: 403, json: { error: 'revoked', spends: [{ id: 'DDDDDDDDDDDDDDDDDDDDDD', void: true }] } }))
    await h.license.use('exports')
    expect(journalOf(h)).toEqual([])
  })

  it('waits USE_TIMEOUT_MS for the server, to the millisecond, and spends from the allowance when nothing answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await holding()
    h.http.hang = true
    let answer: UseResult | undefined
    const asking = h.license.use('exports').then((r) => (answer = r))
    await h.http.whenCalled('use')
    await vi.advanceTimersByTimeAsync(USE_TIMEOUT_MS - 1)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await asking
    expect(answer).toEqual({ ok: true, left: 89, offline: true })
  })

  it('waits for the HTTP bound instead when that is shorter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await holding(METERS, {}, { httpTimeoutMs: 1_000 })
    h.http.hang = true
    let answer: UseResult | undefined
    const asking = h.license.use('exports').then((r) => (answer = r))
    await h.http.whenCalled('use')
    await vi.advanceTimersByTimeAsync(999)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await asking
    expect(answer).toMatchObject({ ok: true, offline: true })
  })
})

describe('use with no answer', () => {
  it('spends from the allowance, journals the spend under the id it sent, and waits a minute before asking again', async () => {
    const h = await holding()
    h.http.fail = true
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89, offline: true })
    const sent = useBody(h).id
    expect(journalOf(h)).toEqual([{ id: sent, meter: 'exports', n: 1, at: NOW, kind: 'unanswered' }])
    expect(h.getStored()).toMatchObject({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    // Inside the wait it asks nothing: the spend is made with no request, and grows one entry.
    expect(await h.license.use('exports', 2)).toEqual({ ok: true, left: 87, offline: true })
    expect(h.http.count('use')).toBe(1)
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['unanswered', 1], ['offline', 2]])
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 86, offline: true })
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['unanswered', 1], ['offline', 3]])
  })

  it('refuses a spend past the allowance, and past what is left', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 3 } })
    h.http.fail = true
    expect(await h.license.use('exports', 2)).toMatchObject({ ok: true, left: 88 })
    expect(await h.license.use('exports', 2)).toEqual({ ok: false, error: 'offline-limit', left: 88 })
    expect(await h.license.use('exports', 1)).toEqual({ ok: true, left: 87, offline: true })
    expect(await h.license.use('exports', 1)).toEqual({ ok: false, error: 'offline-limit', left: 87 })
    const low = await holding({ exports: { left: 2, total: 100, offline: 50 } })
    low.http.fail = true
    expect(await low.license.use('exports', 3)).toEqual({ ok: false, error: 'offline-limit', left: 2 })
    expect(await low.license.use('exports', 2)).toEqual({ ok: true, left: 0, offline: true })
    expect(await low.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 0 })
  })

  it('refuses every spend with no answer on a meter whose allowance is 0', async () => {
    const h = await holding()
    h.http.fail = true
    expect(await h.license.use('renders')).toEqual({ ok: false, error: 'offline-limit', left: 5 })
    // Online it spends as any other.
    h.http.fail = false
    h.setClock(NOW + 2 * MINUTE)
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW + 2 * MINUTE } }))
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
  })

  it('journals a refusal of a spend that was sent as a void, for the server to take it back if it recorded it', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 1 } })
    h.http.fail = true
    await h.license.use('exports')
    h.setClock(NOW + 2 * MINUTE)
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 89 })
    const [first, second] = journalOf(h)
    expect(first).toMatchObject({ kind: 'unanswered', n: 1 })
    expect(second).toEqual({ id: useBody(h, 1).id, meter: 'exports', n: 1, at: NOW + 2 * MINUTE, kind: 'void' })
  })

  it('asks again for a spend the allowance refuses, though the minute has not passed, and journals it as a void when nothing answers', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 1 } })
    h.http.fail = true
    await h.license.use('exports')
    // Inside the wait, but the allowance cannot cover it: asked all the same, so an online customer is not refused.
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 89 })
    expect(h.http.count('use')).toBe(2)
    expect(journalOf(h).map((e) => e.kind)).toEqual(['unanswered', 'void'])
  })

  it('serves a customer who is back online at once, though the last outage left a wait: an online-only meter, a spend past the allowance, a meter the lease lacks', async () => {
    const h = await holding()
    h.http.fail = true
    // The outage: a spend the allowance covers is made with no answer, and the minute’s wait begins.
    expect(await h.license.use('exports')).toMatchObject({ ok: true, offline: true })
    h.http.fail = false
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW } }))
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
    h.http.on('use', () => spent(70))
    // The server’s 70 less the one spend not yet reported.
    expect(await h.license.use('exports', 50)).toEqual({ ok: true, left: 69 })
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { credits: { left: 9, total: 10, offline: 0 } }, at: NOW } }))
    expect(await h.license.use('credits')).toEqual({ ok: true, left: 9 })
    // A spend the allowance covers still waits out the minute.
    const asked = h.http.count('use')
    expect(await h.license.use('exports')).toMatchObject({ ok: true, offline: true })
    expect(h.http.count('use')).toBe(asked)
  })

  it('counts a 5xx and a 429 as no answer, saves nothing of them, and journals the spend in doubt', async () => {
    for (const [status, json] of [[500, { error: 'boom' }], [503, null], [429, { error: 'rate-limited' }]] as const) {
      const h = await holding()
      h.http.on('use', () => ({ status, json }))
      expect(await h.license.use('exports'), String(status)).toEqual({ ok: true, left: 89, offline: true })
      expect(journalOf(h)[0], String(status)).toMatchObject({ kind: 'unanswered', n: 1 })
      expect(h.getStored(), String(status)).not.toHaveProperty('backoffSince')
    }
  })

  it('counts any answer it cannot use as no answer too, and saves nothing of it', async () => {
    const answers: [number, unknown][] = [[200, { spent: false }], [200, 'ok'], [200, null], [400, { error: 'invalid-request' }], [404, { error: 'invalid-key' }], [403, { error: 'something-new' }], [401, 'denied']]
    for (const [status, json] of answers) {
      const h = await holding()
      h.http.on('use', () => ({ status, json }))
      expect(await h.license.use('exports'), String(status)).toEqual({ ok: true, left: 89, offline: true })
      expect(journalOf(h)[0], String(status)).toMatchObject({ kind: 'unanswered' })
      expect(h.getStored(), String(status)).not.toHaveProperty('backoffSince')
      expect(h.getStored(), String(status)).not.toHaveProperty('refused')
    }
  })

  it('does not take the confirmations of an answer it cannot use', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'EEEEEEEEEEEEEEEEEEEEEE', kind: 'unanswered' })] })
    h.http.on('use', () => ({ status: 500, json: { spends: [{ id: 'EEEEEEEEEEEEEEEEEEEEEE', n: 1 }] } }))
    h.setClock(NOW + 2 * MINUTE)
    await h.license.use('exports')
    expect(journalOf(h).map((e) => e.id)).toContain('EEEEEEEEEEEEEEEEEEEEEE')
  })

  it('asks again once the minute is over, and keeps the journal’s own wait: two minutes after two unanswered, then four, to an hour', async () => {
    const h = await holding({ exports: { left: 1_000_000, total: 1_000_000, offline: 1_000_000 } })
    h.http.fail = true
    let at = NOW
    const waits = [1, 2, 4, 8, 16, 32, 60, 60]
    for (const [i, wait] of waits.entries()) {
      h.setClock(at)
      await h.license.use('exports')
      expect(h.http.count('use'), `ask ${i + 1}`).toBe(i + 1)
      // One millisecond short of the wait: not asked.
      h.setClock(at + wait * MINUTE - 1)
      await h.license.use('exports')
      expect(h.http.count('use'), `short of wait ${i + 1}`).toBe(i + 1)
      at += wait * MINUTE
    }
  })

  it('keeps the journal’s wait when the device clock is set back, as the guarded clock does not go back', async () => {
    const h = await holding()
    h.http.fail = true
    h.setClock(NOW + 10 * MINUTE)
    await h.license.use('exports')
    h.setClock(NOW)
    await h.license.use('exports')
    expect(h.http.count('use')).toBe(1)
  })

  it('asks at once when a stored no-answer wait begins after the device clock', async () => {
    const fresh = await holding(METERS, { backoffSince: NOW + 10 * MINUTE, backoffMs: RETRY_UNANSWERED_MS })
    fresh.http.on('use', () => spent(89))
    expect(await fresh.license.use('exports')).toEqual({ ok: true, left: 89 })
  })

  it('asks when the newest unanswered spend was opened after the guarded clock (it jumped ahead and was corrected), not days later', async () => {
    const ahead = await holding(METERS, { spends: [entry({ kind: 'unanswered', at: NOW + 5 * 86_400_000 })] })
    ahead.http.on('use', () => spent(89))
    expect(await ahead.license.use('exports')).toEqual({ ok: true, left: 88 })
    expect(ahead.http.count('use')).toBe(1)
    const now = await holding(METERS, { spends: [entry({ kind: 'unanswered', at: NOW })] })
    now.http.on('use', () => spent(89))
    await now.license.use('exports')
    expect(now.http.count('use')).toBe(0)
  })

  it('does not wait on a longer wait a validate set (an answer without a lease): the use endpoint is asked all the same', async () => {
    const h = await holding(METERS, { backoffSince: NOW, backoffMs: ASK_AGAIN_MS })
    h.http.on('use', () => spent(89))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89 })
  })

  it('refuses a meter the key has no figure for as no-meter, and journals it as a void when it was in doubt', async () => {
    const h = await holding()
    h.http.fail = true
    expect(await h.license.use('credits')).toEqual({ ok: false, error: 'no-meter' })
    expect(journalOf(h)[0]).toMatchObject({ kind: 'void', meter: 'credits', n: 1 })
    // Not sent, nothing journaled.
    // A wait running does not stop the ask: the server may know a meter the lease does not name.
    const w = await holding(METERS, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    expect(await w.license.use('credits')).toEqual({ ok: false, error: 'no-meter' })
    expect(w.http.count('use')).toBe(1)
    expect(journalOf(w)[0]).toMatchObject({ kind: 'void', meter: 'credits' })
  })

  it('fills the journal to 64 and refuses the 65th spend as past the allowance, while an entry that grows takes more', async () => {
    const full = Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: `${String(i).padStart(22, 'x')}`, meter: `m${i}`, kind: 'unanswered', at: NOW - 1 }))
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { spends: full, backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.setClock(NOW)
    // A new entry has no room: the spend is refused, though the allowance had it.
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 90 })
    expect(journalOf(h)).toHaveLength(MAX_PENDING_SPENDS)
  })

  it('lets an offline entry that is already open grow when the journal is full', async () => {
    const full = [
      entry({ id: 'x'.repeat(22), n: 2 }),
      ...Array.from({ length: MAX_PENDING_SPENDS - 1 }, (_, i) => entry({ id: `${String(i).padStart(22, 'y')}`, meter: `m${i}`, kind: 'unanswered', at: NOW - 1 })),
    ]
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { spends: full, backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 87, offline: true })
    expect(journalOf(h)).toHaveLength(MAX_PENDING_SPENDS)
    expect(journalOf(h)[0]).toMatchObject({ n: 3 })
  })
})

describe('what is asked', () => {
  it('refuses an amount that is not a whole number from 1 to the bound, asking nothing', async () => {
    const h = await holding()
    h.http.on('use', () => spent(89))
    for (const n of [0, -1, 1.5, MAX_METER_USES + 1, Number.NaN, Number.POSITIVE_INFINITY, '3', null, {}, [], true]) {
      expect(await h.license.use('exports', n as number), String(n)).toEqual({ ok: false, error: 'invalid-amount' })
    }
    expect(h.http.count('use')).toBe(0)
    expect(h.writes()).toBe(0)
  })

  it('takes the bound itself, and 1 when no amount is given', async () => {
    const h = await holding({ exports: { left: MAX_METER_USES, total: MAX_METER_USES, offline: 10 } })
    h.http.on('use', () => spent(5))
    expect((await h.license.use('exports', MAX_METER_USES)).ok).toBe(true)
    expect(useBody(h).n).toBe(MAX_METER_USES)
    await h.license.use('exports')
    expect(useBody(h, 1).n).toBe(1)
    await h.license.use('exports', undefined)
    expect(useBody(h, 2).n).toBe(1)
  })

  it('judges the amount before the meter, and refuses a code of no meter asking nothing', async () => {
    const h = await holding()
    expect(await h.license.use('', 0)).toEqual({ ok: false, error: 'invalid-amount' })
    for (const code of ['', 'x'.repeat(33), `${'x'.repeat(31)}😀`, 7, null, undefined]) {
      expect(await h.license.use(code as string), String(code)).toEqual({ ok: false, error: 'no-meter' })
    }
    expect(h.http.count('use')).toBe(0)
  })

  it('takes a code of 32 UTF-16 units, a surrogate pair at the edge included, and matches it exactly', async () => {
    const edge = `${'x'.repeat(30)}😀`
    const h = await holding({ [edge]: { left: 5, total: 5, offline: 1 }, ['x'.repeat(32)]: { left: 5, total: 5, offline: 1 } })
    h.http.fail = true
    expect(await h.license.use(edge)).toMatchObject({ ok: true, left: 4 })
    expect(await h.license.use('x'.repeat(32))).toMatchObject({ ok: true, left: 4 })
    expect(await h.license.use('X'.repeat(32))).toEqual({ ok: false, error: 'no-meter' })
  })

  it('spends a meter named like a member of Object.prototype only when the key has it', async () => {
    const h = await holding(METERS)
    h.http.fail = true
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await h.license.use(code), code).toEqual({ ok: false, error: 'no-meter' })
    }
    const own = await holding({ constructor: { left: 3, total: 3, offline: 1 } })
    own.http.fail = true
    expect(await own.license.use('constructor')).toMatchObject({ ok: true, left: 2 })
  })

  it('makes an id of 22 base64url characters, a new one each time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSpendId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
})

describe('when it is not licensed', () => {
  it('is not-licensed with no licence, a trial, an expired or tampered lease, and asks nothing', async () => {
    const none = await harness()
    expect(await none.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })

    const trial = await harness(null)
    trial.http.on('trial', async () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 86_400_000, lease: await trial.sign('trial:abc', 'trial', 86_400) } }))
    await trial.license.startTrial()
    expect(await trial.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })

    const expired = await holding()
    expired.setClock(NOW + 40 * 86_400_000)
    expect(await expired.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })

    const other = await holding()
    other.setStored({ key: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ', activationId: 'act_1', lease: other.lease })
    expect(await other.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })

    for (const h of [none, trial, expired, other]) expect(h.http.count('use')).toBe(0)
  })

  it('is not-licensed with a stored refusal that stands, and for a build the lease does not cover', async () => {
    const refused = await holding(METERS, { refused: 'revoked' })
    expect(await refused.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })
    const outdated = await holding(METERS, { refused: 'upgrade', refusedMajor: 1 })
    expect(await outdated.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })
    expect(refused.http.count('use') + outdated.http.count('use')).toBe(0)
  })

  it('is not-licensed with an offline licence file, which has no meters', async () => {
    const h = await harness()
    const { offlineFor } = await import('./license-file.fixture.js')
    await h.license.importLicenseFile(await offlineFor(h))
    expect((await h.license.status()).source).toBe('file')
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'not-licensed' })
    expect(h.http.count('use')).toBe(0)
  })

  it('answers storage when the state cannot be read just now, asking nothing, and rejects never', async () => {
    const h = await holding()
    h.failRead(1)
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'storage' })
    expect(h.http.count('use')).toBe(0)
    h.http.on('use', () => spent(89))
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89 })
  })

  it('never rejects when an adapter or a step throws: a clock, the key ids; and a request that throws is no answer', async () => {
    const h = await holding()
    const adapters = h.adapters
    const app = (over: Partial<typeof adapters>) => new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...adapters, ...over } })
    const clock = app({ clock: { now: () => { throw new Error('the clock') } } })
    await expect(clock.use('exports')).resolves.toEqual({ ok: false, error: 'storage' })
    class NoKeyIds extends License {
      protected override async keyIds(): Promise<string[]> {
        throw new Error('the key set')
      }
    }
    const ids = new NoKeyIds({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters })
    await expect(ids.use('exports')).resolves.toEqual({ ok: false, error: 'storage' })
    // A request that throws, even before it is sent, is no answer: the allowance serves.
    const post = app({ http: { post: () => { throw new Error('the adapter') } } })
    await expect(post.use('exports')).resolves.toEqual({ ok: true, left: 89, offline: true })
    const fingerprint = await holding(METERS, {}, { fingerprint: { get: () => Promise.reject(new Error('no machine id')) } })
    fingerprint.http.on('use', () => spent(89))
    await expect(fingerprint.license.use('exports')).resolves.toEqual({ ok: true, left: 89 })
  })
})

describe('the journal', () => {
  it('survives a save that fails: the customer has the use, it counts toward the allowance and the status, and lands with the next save that can', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 2 } })
    h.http.fail = true
    h.failWrites(true)
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89, offline: true })
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 88, offline: true })
    expect(journalOf(h)).toEqual([])
    // It counts: the allowance is spent, and the status shows it.
    expect(await h.license.use('exports')).toEqual({ ok: false, error: 'offline-limit', left: 88 })
    expect((await h.license.status()).meters?.exports).toEqual({ left: 88, total: 100, offline: 2, unsynced: 2, resets: false })
    h.failWrites(false)
    await h.license.status()
    // The third call was asked, and in doubt: the server is told it is taken back.
    expect(journalOf(h).filter((e) => e.kind !== 'void').reduce((sum, e) => sum + e.n, 0)).toBe(2)
    expect(journalOf(h).filter((e) => e.kind === 'void')).toHaveLength(1)
    // Landed once: a failing disk again changes nothing the view shows.
    h.failWrites(true)
    expect((await h.license.status()).meters?.exports?.unsynced).toBe(2)
  })

  it('lands with the next use that can save, in order', async () => {
    const h = await holding()
    h.http.fail = true
    h.failWrites(true)
    await h.license.use('exports')
    h.failWrites(false)
    h.http.fail = false
    // The server records the report the request carries, and says so.
    h.http.on('use', (body) => ({ status: 200, json: { ...(spent(88).json as object), spends: (body as { spends: { id: string; n: number }[] }).spends.map(({ id, n }) => ({ id, n })) } }))
    h.setClock(NOW + 2 * MINUTE)
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 88 })
    // The earlier spend rode this request as a report, and its confirmation dropped it.
    expect((useBody(h, 1).spends as unknown[]).length).toBe(1)
    expect(journalOf(h)).toEqual([])
  })

  it('lands on the state as stored now, so a second process’s spend is never lost', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } })
    h.http.fail = true
    const original = h.adapters.storage
    // Another process saves an offline entry between this one’s read and its save.
    let injected = false
    const storage = {
      read: (opts?: { readOnly?: boolean }) => original.read(opts),
      write: (s: StoredState) => original.write(s),
      update: async (merge: (latest: StoredState) => StoredState) => {
        const latest = (await original.read()) ?? {}
        const other = injected ? latest : { ...latest, spends: [entry({ id: 'OOOOOOOOOOOOOOOOOOOOOO', n: 4, kind: 'offline', at: NOW - 5 })], rev: 7 }
        injected = true
        await original.write(merge(other))
      },
    }
    const app = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
    // The first no-answer spend is journaled beside theirs; the second (in its wait) grows the offline entry that is there.
    await app.use('exports')
    await app.use('exports', 2)
    expect(journalOf(h).map((e) => [e.id === 'OOOOOOOOOOOOOOOOOOOOOO' ? 'theirs' : e.kind, e.n])).toEqual([['theirs', 6], ['unanswered', 1]])
  })

  it('keeps an entry in the journal of the activation it is about, and nothing of it on another seat', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 2 })], meterFigures: { exports: { left: 50, total: 100, offline: 10, resets: false, at: NOW } } })
    const lease = await meteredLease(h)
    // The same seat activated again keeps it.
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(journalOf(h)).toHaveLength(1)
    expect(h.getStored()?.meterFigures).toBeDefined()
    // Another seat of the same key starts afresh.
    const other = await meteredLease(h, METERS, { aid: 'act_9' })
    h.http.on('activate', () => ({ status: 200, json: { lease: other, activationId: 'act_9' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.getStored()?.activationId).toBe('act_9')
    expect(h.getStored()?.spends).toBeUndefined()
    expect(h.getStored()?.meterFigures).toBeUndefined()
  })

  it('drops the journal of an old activation when another is activated, unreported', async () => {
    const h = await holding(METERS, { spends: [entry({ n: 2 })], meterFigures: { exports: { left: 50, total: 100, offline: 10, resets: false, at: NOW } } })
    const another = 'SLUICE-OTHER-AAAA-BBBB-CCCC'
    const lease = await meteredLease(h, METERS, { sub: another, aid: 'act_2' })
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_2' } }))
    expect(await h.license.activate(another)).toEqual({ ok: true })
    expect(h.http.count('validate')).toBe(0)
    expect(h.getStored()?.key).toBe(another)
    expect(h.getStored()?.spends).toBeUndefined()
    expect(h.getStored()?.meterFigures).toBeUndefined()
  })

  it('drops entries unreported for more than 180 days at the next save, and keeps the ones inside', async () => {
    const day = 86_400_000
    const h = await holding(METERS, { spends: [entry({ id: 'o'.repeat(22), at: NOW - 181 * day, kind: 'unanswered' }), entry({ id: 'n'.repeat(22), meter: 'exports', at: NOW - 179 * day, kind: 'unanswered' })] })
    h.http.fail = true
    await h.license.use('exports')
    expect(journalOf(h).map((e) => e.id)).not.toContain('o'.repeat(22))
    expect(journalOf(h).map((e) => e.id)).toContain('n'.repeat(22))
  })

  it('reads a stored journal that is not one as an empty journal, and an entry of another shape as none', async () => {
    const h = await holding(METERS, { spends: 'junk' as never })
    h.http.fail = true
    expect(await h.license.use('exports')).toEqual({ ok: true, left: 89, offline: true })
    const g = await holding(METERS, { spends: [{ id: 3 }, null, entry({ n: 2 }), { id: 'x', meter: 'exports', n: 0, at: 1, kind: 'offline' }] as never })
    g.http.fail = true
    expect((await g.license.status()).meters?.exports?.unsynced).toBe(2)
  })
})

describe('the device', () => {
  it('names the device as a validate does: its fingerprints and what they hash', async () => {
    const machine = { get: async () => 'fp-machine', identify: async () => ({ fingerprint: 'fp-machine', kind: 'machine' as const, alternates: ['fp-host'] }) }
    const h = await holding(METERS, {}, { fingerprint: machine })
    h.http.on('use', () => spent(89))
    await h.license.use('exports')
    expect(useBody(h)).toMatchObject({ fingerprintKind: 'machine' })
    expect(useBody(h).fingerprints).toHaveLength(2)
  })

  it('keys the install by the machine id it read, when the request gets no answer', async () => {
    const machine = { get: async () => 'fp-machine', identify: async () => ({ fingerprint: 'fp-machine', kind: 'machine' as const, alternates: [] }) }
    const h = await holding(METERS, {}, { fingerprint: machine })
    h.http.fail = true
    await h.license.use('exports')
    expect(h.getStored()?.deviceKind).toBe('machine')
  })

  it('sends no fingerprints when devices are not held (deviceHold false) or the device cannot be told', async () => {
    const pooled = await holding(METERS, {}, { deviceHold: false })
    pooled.http.on('use', () => spent(89))
    await pooled.license.use('exports')
    expect(useBody(pooled)).not.toHaveProperty('fingerprints')
    expect(useBody(pooled)).not.toHaveProperty('fingerprintKind')
    const unknown = await holding(METERS, {}, { fingerprint: { get: () => Promise.reject(new Error('no id')) } })
    unknown.http.on('use', () => spent(89))
    await unknown.license.use('exports')
    expect(useBody(unknown)).not.toHaveProperty('fingerprints')
  })
})

describe('a spend held in memory', () => {
  /** The server renews with the lease the harness's key signs for the key. */
  const renewing = (h: Awaited<ReturnType<typeof holding>>) => h.http.on('validate', async () => ({ status: 200, json: { lease: await meteredLease(h) } }))
  const reportOf = (h: Awaited<ReturnType<typeof holding>>, nth: number) => (h.http.calls.filter((c) => c.action === 'validate')[nth]?.body as { spends?: unknown }).spends

  it('is not reported until it has landed, so the entry it joins is reported with it, once', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    renewing(h)
    h.failWrites(true)
    expect(await h.license.use('exports', 2)).toEqual({ ok: true, left: 88, offline: true })
    // Held in memory, it counts toward the status but no request carries it: it has no place in the journal yet.
    expect((await h.license.refresh()).meters?.exports).toMatchObject({ left: 88, unsynced: 2 })
    expect(reportOf(h, 0)).toBeUndefined()
    // Another process lands an entry, and the disk is back: the spend lands in it, and the entry is what is reported.
    h.setStored({ ...h.getStored(), spends: [entry({ id: 'Y'.repeat(22), n: 1, at: NOW - 5 })] })
    h.failWrites(false)
    await h.license.refresh()
    expect(reportOf(h, 1)).toEqual([{ id: 'Y'.repeat(22), meter: 'exports', n: 3, at: NOW - 5 }])
  })

  it('is reported with a release once it has landed, as everything the journal holds', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    h.failWrites(true)
    await h.license.use('exports', 2)
    h.failWrites(false)
    await h.license.deactivate()
    expect(h.http.bodyOf('deactivate')).toMatchObject({ spends: [{ meter: 'exports', n: 2 }] })
  })

  it('reports an unanswered spend and a void, which open once by their ids, and withholds only the offline spends', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 }, renders: { left: 5, total: 5, offline: 0, resets: true } })
    renewing(h)
    h.failWrites(true)
    h.http.fail = true
    // In doubt, then refused after asking: an unanswered spend, and a void. A third, made while the journal waits, never left the device.
    expect(await h.license.use('exports', 2)).toEqual({ ok: true, left: 88, offline: true })
    expect(await h.license.use('renders')).toMatchObject({ ok: false, error: 'offline-limit' })
    expect(await h.license.use('exports', 1)).toEqual({ ok: true, left: 87, offline: true })
    h.http.fail = false
    await h.license.refresh()
    const report = reportOf(h, 0) as { meter: string; n: number; void?: true }[]
    expect(report.map((e) => [e.meter, e.n, e.void === true])).toEqual([['exports', 2, false], ['renders', 1, true]])
  })

  it('judges a view that carried held spends by what is stored, though a save in the same call landed them', async () => {
    const h = await harness()
    const lease = await signLease(
      { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: OPEN_MAJOR, upgradeUntil: Math.floor((NOW + 10 * 86_400_000) / 1000), ent: {}, met: { exports: { left: 90, total: 100, offline: 10 } }, ttlSeconds: 30 * 86_400 },
      h.signingKey,
      NOW,
    )
    h.setStored({ key: KEY, activationId: 'act_1', lease, backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    const original = h.adapters.storage
    let mode: 'failing' | 'flaky' = 'failing'
    let saves = 0
    const storage = {
      read: (opts?: { readOnly?: boolean }) => original.read(opts),
      write: (s: StoredState) => original.write(s),
      update: async (merge: (latest: StoredState) => StoredState) => {
        if (mode === 'failing') throw new Error('EBUSY: the disk said no')
        saves += 1
        // The first save of the next call fails; before the second another process lands an entry the held spend joins.
        if (saves === 1) throw new Error('EBUSY: the disk said no')
        const latest = (await original.read()) ?? {}
        await original.write(merge(saves === 2 ? { ...latest, spends: [entry({ id: 'Y'.repeat(22), n: 1, at: NOW - 5 })] } : latest))
      },
    }
    const app = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
    h.http.on('validate', async () => ({ status: 200, json: { lease } }))
    expect(await app.use('exports', 2)).toEqual({ ok: true, left: 88, offline: true })
    mode = 'flaky'
    await app.refresh()
    // The spend landed in that entry before the request was made; the request reports the entry, not the spend under an id of its own.
    expect((h.http.bodyOf('validate') as { spends?: unknown }).spends).toEqual([{ id: 'Y'.repeat(22), meter: 'exports', n: 3, at: NOW - 5 }])
  })

  it('does not make status() ask at every call for spends held in memory that no request carries', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    renewing(h)
    h.failWrites(true)
    await h.license.use('exports', 2)
    h.setClock(NOW + 2 * MINUTE)
    for (let i = 0; i < 3; i += 1) await h.license.status()
    expect(h.http.count('validate')).toBe(0)
    // Landed, the journal asks as it does, once.
    h.failWrites(false)
    await h.license.status()
    expect(h.http.count('validate')).toBe(1)
  })

  it('starts the hour’s wait after an answer only when the request carried a report, not for a journal that only it read', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    renewing(h)
    const original = h.adapters.storage
    let writes: 'refused' | 'refused once' | 'allowed' = 'refused'
    const storage = {
      read: (opts?: { readOnly?: boolean }) => original.read(opts),
      write: (s: StoredState) => original.write(s),
      update: async (merge: (latest: StoredState) => StoredState) => {
        if (writes === 'refused') throw new Error('EBUSY: the disk said no')
        if (writes === 'refused once') {
          writes = 'allowed'
          throw new Error('EBUSY: the disk said no')
        }
        await original.write(merge((await original.read()) ?? {}))
      },
    }
    const app = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
    expect(await app.use('exports', 2)).toEqual({ ok: true, left: 88, offline: true })
    // The next call's first save fails and its answer's save lands the spend: it read a journal, and sent none of it.
    writes = 'refused once'
    await app.refresh()
    expect(reportOf(h, 0)).toBeUndefined()
    expect(journalOf(h)).toHaveLength(1)
    expect(h.getStored()?.backoffMs).not.toBe(ASK_AGAIN_MS)
    // So the journal that has landed is offered at the next status() once the minute's wait is over, not an hour on.
    h.setClock(NOW + 2 * MINUTE)
    await app.status()
    expect(h.http.count('validate')).toBe(2)
    expect(reportOf(h, 1)).toEqual([expect.objectContaining({ meter: 'exports', n: 2 })])
  })

  it('is not reported with a use either, whose own spend is: the report is what is stored', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 }, renders: { left: 5, total: 5, offline: 0, resets: true } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.failWrites(true)
    await h.license.use('exports', 2)
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW } }))
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
    expect(useBody(h)).toMatchObject({ meter: 'renders', n: 1 })
    expect(useBody(h)).not.toHaveProperty('spends')
  })
})

describe('calls one at a time', () => {
  it('runs two calls made together one after the other, each a spend of its own', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } })
    h.http.fail = true
    const [a, b] = await Promise.all([h.license.use('exports', 3), h.license.use('exports', 4)])
    expect(a).toEqual({ ok: true, left: 87, offline: true })
    expect(b).toEqual({ ok: true, left: 83, offline: true })
    expect(journalOf(h).reduce((sum, e) => sum + e.n, 0)).toBe(7)
  })

  it('waits behind a status() already running, and sees what it saved', async () => {
    const h = await holding()
    const lease = await meteredLease(h, { exports: { left: 60, total: 100, offline: 10 } }, { now: NOW + 1000 })
    h.setClock(NOW + 1000)
    h.http.on('validate', () => ({ status: 200, json: { lease } }))
    h.http.on('use', () => spent(59, NOW + 1000))
    const refreshing = h.license.refresh()
    const spending = h.license.use('exports')
    await refreshing
    expect(await spending).toEqual({ ok: true, left: 59 })
  })
})

describe('a disk that keeps refusing', () => {
  it('costs the process a short list of changes, however many spends it holds, and none of them is lost', async () => {
    const h = await holding({ exports: { left: 1_000_000, total: 1_000_000, offline: 1_000_000 } })
    h.http.fail = true
    h.failWrites(true)
    for (let i = 0; i < 400; i += 1) expect((await h.license.use('exports')).ok).toBe(true)
    expect((await h.license.status()).meters?.exports).toMatchObject({ left: 1_000_000 - 400, unsynced: 400 })
    h.failWrites(false)
    await h.license.status()
    expect(journalOf(h).reduce((sum, e) => sum + e.n, 0)).toBe(400)
  })
})

describe('a disk that keeps refusing, and a spend the allowance cannot cover', () => {
  it('keeps the newest MAX_PENDING_VOIDS voids in memory, none of them told, and refuses no covered spend for them', async () => {
    const h = await holding()
    h.http.fail = true
    h.failWrites(true)
    for (let minute = 0; minute < 20; minute += 1) {
      h.setClock(NOW + minute * MINUTE)
      expect(await h.license.use('renders')).toEqual({ ok: false, error: 'offline-limit', left: 5 })
    }
    // A spend the allowance covers is made, whatever the uncovered ones did to what this process holds.
    expect(await h.license.use('exports', 3)).toEqual({ ok: true, left: 87, offline: true })
    h.failWrites(false)
    await h.license.status()
    const stored = journalOf(h)
    // A void is no spend told: it lands under the journal’s rules, the newest sixteen of the twenty.
    expect(stored.filter((e) => e.kind === 'void').map((e) => e.at)).toEqual(Array.from({ length: MAX_PENDING_VOIDS }, (_, i) => NOW + (4 + i) * MINUTE))
    expect(stored.filter((e) => e.kind !== 'void').map((e) => [e.meter, e.n])).toEqual([['exports', 3]])
  })
})

describe('two instances of the app over one state file', () => {
  it('never lose each other’s spends: a save that finds the file changed under it merges onto it, and lands once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keygrant-use-'))
    try {
      const h = await holding({ exports: { left: 1_000, total: 1_000, offline: 1_000 } })
      const path = join(dir, 'sluice.json')
      await createFileStorage(path).write({ key: KEY, activationId: 'act_1', lease: h.lease })
      h.http.fail = true
      const instance = (storage: ReturnType<typeof createFileStorage>) => new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
      const b = instance(createFileStorage(path))
      // A’s first save has read the file and is making its temp file: there, the other instance spends and saves, so A’s
      // revision check (storage.ts `update`) finds the file changed and merges onto it. No timing: B runs inside A’s write.
      let creates = 0
      let armed = true
      const fsOfA: StorageFs = {
        ...nodeFs,
        create: async (file) => {
          creates += 1
          if (armed) {
            armed = false
            expect(await b.use('exports', 7)).toMatchObject({ ok: true, offline: true })
          }
          return nodeFs.create(file)
        },
      }
      const a = instance(createFileStorage(path, { fs: fsOfA }))
      expect(await a.use('exports', 5)).toMatchObject({ ok: true, offline: true })
      // A’s first save was made twice (merged again), then its spend was saved.
      expect(creates).toBe(3)
      const saved = JSON.parse(await readFile(path, 'utf8')) as { spends: { n: number; kind: string }[] }
      expect(saved.spends.map((e) => [e.kind, e.n]).sort()).toEqual([['unanswered', 5], ['unanswered', 7]])
      expect((await a.status()).meters?.exports?.unsynced).toBe(12)
      expect((await b.status()).meters?.exports?.unsynced).toBe(12)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the allowance, judged where the spend lands', () => {
  /** A License over the harness’s state whose first save finds `theirs` already there: another process’s entries. */
  function racing(h: Awaited<ReturnType<typeof holding>>, theirs: StoredState['spends']) {
    const original = h.adapters.storage
    let injected = false
    const storage = {
      read: (opts?: { readOnly?: boolean }) => original.read(opts),
      write: (s: StoredState) => original.write(s),
      update: async (merge: (latest: StoredState) => StoredState) => {
        const latest = (await original.read()) ?? {}
        const other = injected ? latest : { ...latest, spends: theirs, rev: 9 }
        injected = true
        await original.write(merge(other))
      },
    }
    return new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
  }

  it('refuses a spend that another process took the allowance from meanwhile, and keeps theirs', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    const app = racing(h, [entry({ id: 'T'.repeat(22), n: 8, at: NOW - 5 })])
    // Read with nothing unsynced, so the allowance covers 5; by the time it lands, 8 are there: 13 would pass 10.
    // What is left is as the landing found it: the 90, less the 8 the other process had spent by then.
    expect(await app.use('exports', 5)).toEqual({ ok: false, error: 'offline-limit', left: 82 })
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['offline', 8]])
    // What the allowance still covers lands.
    expect(await app.use('exports', 2)).toMatchObject({ ok: true, offline: true })
    expect(journalOf(h).map((e) => e.n)).toEqual([10])
  })

  it('holds a spend to what is left when that is below the allowance: two processes spending the last two, one lands', async () => {
    const h = await holding({ exports: { left: 2, total: 100, offline: 50 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    const app = racing(h, [entry({ id: 'T'.repeat(22), n: 2, at: NOW - 5 })])
    // The allowance of 50 would take it; the 2 that are left, and the other process has spent them.
    expect(await app.use('exports', 2)).toEqual({ ok: false, error: 'offline-limit', left: 0 })
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['offline', 2]])
    const alone = await holding({ exports: { left: 2, total: 100, offline: 50 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    expect(await alone.license.use('exports', 2)).toEqual({ ok: true, left: 0, offline: true })
    expect(await alone.license.use('exports', 1)).toEqual({ ok: false, error: 'offline-limit', left: 0 })
  })

  it('journals a void for a spend that was in doubt and is then refused at landing', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } })
    h.http.fail = true
    const app = racing(h, [entry({ id: 'T'.repeat(22), n: 8, at: NOW - 5 })])
    expect(await app.use('exports', 5)).toEqual({ ok: false, error: 'offline-limit', left: 82 })
    const sent = useBody(h).id
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['offline', 8], ['void', 5]])
    expect(journalOf(h)[1]?.id).toBe(sent)
  })

  it('never takes back a spend the customer was told was made: it lands past the allowance', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.failWrites(true)
    expect(await h.license.use('exports', 6)).toMatchObject({ ok: true, left: 84, offline: true })
    h.failWrites(false)
    // Meanwhile another process of the app spent 8, and the journal is full.
    const crowd = Array.from({ length: MAX_PENDING_SPENDS - 1 }, (_, i) => entry({ id: String(i).padStart(22, 'c'), meter: `m${i}`, kind: 'unanswered', at: NOW - 100 }))
    h.setStored({ ...h.getStored(), spends: [entry({ id: 'T'.repeat(22), n: 8 }), ...crowd] })
    await h.license.status()
    expect(journalOf(h)).toHaveLength(MAX_PENDING_SPENDS)
    expect(journalOf(h)[0]).toMatchObject({ id: 'T'.repeat(22), n: 14 })
    expect((await h.license.status()).meters?.exports).toMatchObject({ unsynced: 14, left: 76 })
  })

  it('lands a spend the customer was told was made as a 65th entry, past the cap, when it opens an entry of its own', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    h.failWrites(true)
    expect(await h.license.use('exports', 2)).toMatchObject({ ok: true })
    h.failWrites(false)
    h.setStored({ ...h.getStored(), spends: Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: String(i).padStart(22, 'c'), meter: `m${i}`, kind: 'unanswered', at: NOW - 100 })) })
    await h.license.status()
    expect(journalOf(h)).toHaveLength(MAX_PENDING_SPENDS + 1)
    expect(journalOf(h).at(-1)).toMatchObject({ meter: 'exports', n: 2, kind: 'offline' })
  })
})

describe('what is left when a landing refuses a spend and the state cannot say', () => {
  /** A License over the harness’s state whose first save lands `theirs` (and `drop`s what it names) before it, and whose reads then fail when `failReads`. */
  function landing(h: Awaited<ReturnType<typeof holding>>, theirs: StoredState['spends'], opts: { drop?: boolean; failReads?: boolean }) {
    const original = h.adapters.storage
    let saved = false
    const storage = {
      read: async (readOpts?: { readOnly?: boolean }) => {
        if (saved && opts.failReads === true) throw new Error('the disk is gone')
        return original.read(readOpts)
      },
      write: (s: StoredState) => original.write(s),
      update: async (merge: (latest: StoredState) => StoredState) => {
        const latest = (await original.read()) ?? {}
        const other = { ...latest, spends: theirs, rev: 9, ...(opts.drop === true ? { meterFigures: undefined } : {}) }
        await original.write(merge(other))
        saved = true
      },
    }
    return new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
  }

  it('answers 0 left when the state cannot be read again just after the refusal, however much the figure was', async () => {
    const h = await holding({ exports: { left: 90, total: 100, offline: 10 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS })
    const app = landing(h, [entry({ id: 'T'.repeat(22), n: 8, at: NOW - 5 })], { failReads: true })
    expect(await app.use('exports', 5)).toEqual({ ok: false, error: 'offline-limit', left: 0 })
    // The refusal stands, and their spend is kept: only the figure was lost to the customer.
    expect(journalOf(h).map((e) => [e.kind, e.n])).toEqual([['offline', 8]])
  })

  it('answers 0 left when the state as the landing found it has no figure for the meter any more', async () => {
    // The lease names no credits; the figure is a use answer’s, stored beside it, and the other process’s state has dropped it.
    const h = await holding(METERS, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS, meterFigures: { credits: { left: 20, total: 20, offline: 10, resets: false, at: NOW } } })
    expect((await h.license.status()).meters?.credits).toMatchObject({ left: 20, offline: 10 })
    const app = landing(h, [entry({ id: 'T'.repeat(22), meter: 'credits', n: 8, at: NOW - 5 })], { drop: true })
    expect(await app.use('credits', 5)).toEqual({ ok: false, error: 'offline-limit', left: 0 })
    expect(journalOf(h).map((e) => [e.meter, e.kind, e.n])).toEqual([['credits', 'offline', 8]])
    // With the figure kept, the same refusal says what is left: 20 less their 8.
    const kept = await holding(METERS, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS, meterFigures: { credits: { left: 20, total: 20, offline: 10, resets: false, at: NOW } } })
    const app2 = landing(kept, [entry({ id: 'T'.repeat(22), meter: 'credits', n: 8, at: NOW - 5 })], {})
    expect(await app2.use('credits', 5)).toEqual({ ok: false, error: 'offline-limit', left: 12 })
  })
})

describe('what an answer stamps', () => {
  const unconfirmed = async (answer: { status: number; json: unknown } | null) => {
    const h = await holding(METERS, { verdictAt: 111 })
    if (answer === null) h.http.fail = true
    else h.http.on('use', () => answer)
    await h.license.use('exports')
    return h
  }

  it('leaves verdictAt alone for a spend, used-up and an unknown meter: they are no verdict', async () => {
    for (const answer of [spent(89, NOW + 5), { status: 409, json: { error: 'used-up', left: 0, meters: METERS, at: NOW } }, { status: 404, json: { error: 'unknown-meter' } }]) {
      expect((await unconfirmed(answer)).getStored()?.verdictAt, JSON.stringify(answer).slice(0, 40)).toBe(111)
    }
  })

  it('sets it for a verdict and for a wait, as a validate’s answer does', async () => {
    expect((await unconfirmed({ status: 403, json: { error: 'revoked' } })).getStored()?.verdictAt).toBe(NOW)
    expect((await unconfirmed(null)).getStored()?.verdictAt).toBe(NOW)
  })

  it('lets a validate that was in flight across a spend keep its lease', async () => {
    const h = await holding()
    const other = h.licenseFor(1)
    const renewed = await meteredLease(h, METERS, { now: NOW + 1_000 })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.http.on('validate', async () => {
      await gate
      return { status: 200, json: { lease: renewed } }
    })
    h.http.on('use', () => spent(89, NOW + 2_000))
    const validating = h.license.refresh()
    await h.http.whenCalled('validate')
    // Another process spends, asked later and answered first.
    h.setClock(NOW + 2_000)
    expect(await other.use('exports')).toEqual({ ok: true, left: 89 })
    expect(h.getStored()?.verdictAt).toBeUndefined()
    release()
    await validating
    expect(h.getStored()?.lease).toBe(renewed)
  })
})

describe('a spend kept while a save is in flight', () => {
  it('is counted once beside the one that save carries, not folded into it and dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await holding({ exports: { left: 90, total: 100, offline: 50 } }, { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS, lastSeen: NOW })
    // A: kept in memory because the disk refused it.
    h.failWrites(true)
    expect(await h.license.use('exports', 2)).toMatchObject({ ok: true, offline: true })
    h.failWrites(false)
    // A save in flight carries A and is held inside the storage.
    h.http.fail = true
    const release = h.holdNextWrite()
    const refreshing = h.license.refresh()
    await h.whenWritten(h.writes() + 1)
    // B, of the same meter, is made behind it: kept in memory, beside A.
    const second = h.license.use('exports', 3)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await second).toMatchObject({ ok: true, offline: true })
    release()
    await refreshing
    await h.license.status()
    expect(journalOf(h).reduce((sum, e) => sum + e.n, 0)).toBe(5)
    expect((await h.license.status()).meters?.exports?.unsynced).toBe(5)
  })
})

describe('a spend the allowance cannot cover, while nothing answers', () => {
  it('asks once a minute, keeps at most MAX_PENDING_VOIDS voids, and leaves the journal its room for the spends it can make', async () => {
    const h = await holding()
    h.http.fail = true
    for (let minute = 0; minute < 30; minute += 1) {
      h.setClock(NOW + minute * MINUTE)
      expect(await h.license.use('renders')).toEqual({ ok: false, error: 'offline-limit', left: 5 })
      // The same minute: the void is a wait of its own, and nothing is asked.
      expect(await h.license.use('renders')).toEqual({ ok: false, error: 'offline-limit', left: 5 })
    }
    expect(h.http.count('use')).toBe(30)
    const voids = journalOf(h).filter((e) => e.kind === 'void')
    expect(voids).toHaveLength(MAX_PENDING_VOIDS)
    // The newest sixteen stay: the first void to go was the oldest.
    expect(voids.map((e) => e.at)).toEqual(Array.from({ length: MAX_PENDING_VOIDS }, (_, i) => NOW + (14 + i) * MINUTE))
    // A spend on another meter that its allowance covers is made, whatever the uncovered ones did to the journal.
    expect(await h.license.use('exports', 3)).toEqual({ ok: true, left: 87, offline: true })
    expect(journalOf(h)).toHaveLength(MAX_PENDING_VOIDS + 1)
  })

  it('asks again when the device clock is set back below the void, though the guarded clock’s minute is still running', async () => {
    const h = await holding()
    h.http.fail = true
    h.setClock(NOW + 10 * MINUTE)
    expect(await h.license.use('renders')).toMatchObject({ ok: false, error: 'offline-limit' })
    // Inside the void’s minute by both clocks: nothing is asked.
    h.setClock(NOW + 10 * MINUTE + 1000)
    expect(await h.license.use('renders')).toMatchObject({ ok: false, error: 'offline-limit' })
    expect(h.http.count('use')).toBe(1)
    // The device clock is set back to before the void while the guard stands at its minute: the wait is none, and a customer who is online is served.
    h.http.fail = false
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW } }))
    h.setClock(NOW)
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
    expect(h.http.count('use')).toBe(2)
  })

  it('is served at once when the server is back and its minute is over, not before', async () => {
    const h = await holding()
    h.http.fail = true
    expect(await h.license.use('renders')).toMatchObject({ ok: false, error: 'offline-limit' })
    h.http.fail = false
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW + MINUTE } }))
    // Inside the void’s minute: refused without asking.
    h.setClock(NOW + MINUTE - 1)
    expect(await h.license.use('renders')).toMatchObject({ ok: false, error: 'offline-limit' })
    expect(h.http.count('use')).toBe(1)
    h.setClock(NOW + MINUTE)
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
  })

  it('asks for it whatever an unanswered spend of a covered meter waits for, and a void that is ahead of the clock', async () => {
    const h = await holding(METERS, { spends: [entry({ id: 'U'.repeat(22), kind: 'unanswered', at: NOW - 1_000 }), entry({ id: 'V'.repeat(22), kind: 'void', at: NOW + 86_400_000 })] })
    h.http.on('use', () => ({ status: 200, json: { spent: true, meters: { renders: { left: 4, total: 5, offline: 0, resets: true } }, at: NOW } }))
    expect(await h.license.use('renders')).toEqual({ ok: true, left: 4 })
  })
})

describe('a wait that cannot be measured', () => {
  it('leaves out only the entries ahead of the guarded clock, and the others wait as they would alone', async () => {
    const ahead = entry({ id: 'Z'.repeat(22), kind: 'unanswered', at: NOW + 5 * 86_400_000 })
    const waiting = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), kind: 'unanswered', at: NOW - 30_000 }), ahead] })
    waiting.http.on('use', () => spent(89))
    await waiting.license.use('exports')
    expect(waiting.http.count('use')).toBe(0)
    const over = await holding(METERS, { spends: [entry({ id: 'A'.repeat(22), kind: 'unanswered', at: NOW - 2 * MINUTE }), ahead] })
    over.http.on('use', () => spent(89))
    await over.license.use('exports')
    expect(over.http.count('use')).toBe(1)
  })
})
