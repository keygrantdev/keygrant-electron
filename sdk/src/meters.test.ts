import { describe, it, expect } from 'vitest'
import { metersOf } from '@keygrant/shared'
import {
  MAX_METER_USES,
  MAX_PENDING_SPENDS,
  MAX_PENDING_VOIDS,
  PENDING_MAX_MS,
  askedFor,
  figuresOf,
  journalAsks,
  journalWaiting,
  meterStatusOf,
  offlineSpend,
  spendsConfirmed,
  spendsReported,
  useAsksNow,
  useOutcome,
  voidWaiting,
} from './meters.js'
import { compacted, journaled, landJournal, type JournalOp } from './journal.js'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from './offline.js'
import { NOW } from './license.fixture.js'
import { entry } from './meters.fixture.js'

/**
 * The decisions under `use()` and `status().meters` (the SDK contract, section 12), by the rule each states.
 * The conformance vectors pin the same decisions for the ports; these hold the reference to the contract
 * itself, so the vectors cannot only agree with a reference that is wrong.
 */

const MINUTE = 60_000
const figure = (left: number, total = 100, offline = 10, resets = false) => ({ left, total, offline, resets })
const A = 'act_1'
const journal = (spends: ReturnType<typeof entry>[]) => ({ activationId: A, spends })
const offline = (n: number, over: Partial<Extract<JournalOp, { meter: string }>> = {}): JournalOp => ({ kind: 'offline', about: A, id: 'N'.repeat(22), meter: 'exports', n, at: NOW, ...over })

describe('what is asked', () => {
  it('takes a whole number from 1 to the bound, 1 for none, and judges the amount before the code', () => {
    expect(askedFor('exports', undefined)).toEqual({ meter: 'exports', n: 1 })
    expect(askedFor('exports', MAX_METER_USES)).toEqual({ meter: 'exports', n: MAX_METER_USES })
    for (const n of [0, -1, 1.5, MAX_METER_USES + 1, Number.NaN, Infinity, '1', null, true, 2 ** 53]) expect(askedFor('exports', n), String(n)).toEqual({ refused: 'invalid-amount' })
    expect(askedFor('', 0)).toEqual({ refused: 'invalid-amount' })
    expect(askedFor('', 1)).toEqual({ refused: 'no-meter' })
  })

  it('counts a code in UTF-16 units: 32 are a code, 33 are not, a surrogate pair is two', () => {
    expect(askedFor('x'.repeat(32), 1)).toMatchObject({ n: 1 })
    expect(askedFor('x'.repeat(33), 1)).toEqual({ refused: 'no-meter' })
    expect(askedFor(`${'x'.repeat(30)}😀`, 1)).toMatchObject({ n: 1 })
    expect(askedFor(`${'x'.repeat(31)}😀`, 1)).toEqual({ refused: 'no-meter' })
    for (const code of [7, null, undefined, {}]) expect(askedFor(code, 1), String(code)).toEqual({ refused: 'no-meter' })
  })
})

describe('the base figures', () => {
  const met = metersOf({ exports: { left: 90, total: 100, offline: 10 }, renders: { left: 5, total: 5, offline: 0, resets: true } })
  const iat = 1_790_000_000
  const at = iat * 1000

  it('are the lease’s when nothing is stored', () => {
    expect(figuresOf(met, iat, undefined)).toEqual({ exports: figure(90), renders: figure(5, 5, 0, true) })
  })

  it('are a stored figure when it is from the lease’s own second or later, and the lease’s when it is a millisecond before', () => {
    const stored = (when: number) => ({ exports: { ...figure(40), at: when } })
    expect(figuresOf(met, iat, stored(at)).exports).toEqual(figure(40))
    expect(figuresOf(met, iat, stored(at + 999)).exports).toEqual(figure(40))
    expect(figuresOf(met, iat, stored(at - 1)).exports).toEqual(figure(90))
  })

  it('name a meter only a newer stored figure names, and drop one the newest lease no longer names', () => {
    const base = figuresOf(met, iat, { added: { ...figure(7, 7, 1), at: at + 1 }, gone: { ...figure(7, 7, 1), at: at - 1 } })
    expect(Object.keys(base).sort()).toEqual(['added', 'exports', 'renders'])
    expect(figuresOf(undefined, iat, undefined)).toEqual({})
  })

  it('read a stored figure of another shape as none, and never throw', () => {
    for (const stored of ['x', 7, null, [], { exports: 'x' }, { exports: { left: -1, total: 1, offline: 1, at } }, { exports: { left: 1, total: 1, offline: 1 } }]) {
      expect(figuresOf(met, iat, stored).exports, JSON.stringify(stored)).toEqual(figure(90))
    }
  })
})

describe('the status’s meters', () => {
  it('take the unsynced spends off left, count no void, and never go below 0', () => {
    const figures = { exports: figure(90), renders: figure(5, 5, 0, true) }
    const spends = [entry({ n: 4 }), entry({ id: 'B'.repeat(22), n: 3, kind: 'unanswered' }), entry({ id: 'C'.repeat(22), n: 50, kind: 'void' }), entry({ id: 'D'.repeat(22), meter: 'renders', n: 9 })]
    expect(meterStatusOf(figures, spends)).toEqual({
      exports: { left: 83, total: 100, offline: 10, unsynced: 7, resets: false },
      renders: { left: 0, total: 5, offline: 0, unsynced: 9, resets: true },
    })
  })
})

describe('a spend with no answer', () => {
  it('is allowed up to the allowance and up to what is left, and answers what is left after it', () => {
    expect(offlineSpend({ exports: figure(90) }, [], 'exports', 10)).toEqual({ ok: true, left: 80, limit: 10 })
    expect(offlineSpend({ exports: figure(90) }, [entry({ n: 4 })], 'exports', 6)).toEqual({ ok: true, left: 80, limit: 10 })
    expect(offlineSpend({ exports: figure(4) }, [], 'exports', 4)).toEqual({ ok: true, left: 0, limit: 4 })
  })

  it('is refused past either, with what is left, and always for an allowance of 0', () => {
    expect(offlineSpend({ exports: figure(90) }, [], 'exports', 11)).toEqual({ ok: false, error: 'offline-limit', left: 90 })
    expect(offlineSpend({ exports: figure(4) }, [], 'exports', 5)).toEqual({ ok: false, error: 'offline-limit', left: 4 })
    expect(offlineSpend({ exports: figure(90, 100, 0) }, [], 'exports', 1)).toEqual({ ok: false, error: 'offline-limit', left: 90 })
    expect(offlineSpend({ exports: figure(5, 100, 50) }, [entry({ n: 12 })], 'exports', 1)).toEqual({ ok: false, error: 'offline-limit', left: 0 })
  })

  it('counts the unsynced of its own meter and of both kinds, never a void, and knows no meter without a figure', () => {
    const spends = [entry({ n: 4 }), entry({ id: 'B'.repeat(22), n: 3, kind: 'unanswered' }), entry({ id: 'C'.repeat(22), n: 50, kind: 'void' }), entry({ id: 'D'.repeat(22), meter: 'renders', n: 9 })]
    expect(offlineSpend({ exports: figure(90) }, spends, 'exports', 3)).toEqual({ ok: true, left: 80, limit: 10 })
    expect(offlineSpend({ exports: figure(90) }, spends, 'exports', 4)).toMatchObject({ ok: false, left: 83 })
    expect(offlineSpend({ exports: figure(90) }, [], 'credits', 1)).toEqual({ ok: false, error: 'no-meter' })
    expect(offlineSpend({ exports: figure(90) }, [], 'constructor', 1)).toEqual({ ok: false, error: 'no-meter' })
  })
})

describe('when use() asks', () => {
  const unanswered = (k: number, ago: number) => Array.from({ length: k }, (_, i) => entry({ id: String(i).padStart(22, 'k'), kind: 'unanswered', at: NOW - (i === k - 1 ? ago : ago + HOUR) }))
  const HOUR = 3_600_000
  const asks = (state: Parameters<typeof useAsksNow>[0]['state'], over: { clockNow?: number; now?: number; covered?: boolean } = {}) =>
    useAsksNow({ state, clockNow: over.clockNow ?? NOW, now: over.now ?? NOW, covered: over.covered ?? true })

  it('asks every time, but while a no-answer wait runs on the device clock', () => {
    expect(asks({})).toBe(true)
    expect(asks({ backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS })).toBe(false)
    expect(asks({ backoffSince: NOW - RETRY_UNANSWERED_MS, backoffMs: RETRY_UNANSWERED_MS })).toBe(true)
    expect(asks({ backoffSince: NOW + 1000, backoffMs: RETRY_UNANSWERED_MS })).toBe(true)
    expect(asks({ backoffSince: NOW - 1000, backoffMs: ASK_AGAIN_MS })).toBe(true)
  })

  it('waits a minute after one unanswered spend, doubling with each, to an hour from the seventh on', () => {
    const waits = [1, 2, 4, 8, 16, 32, 60, 60, 60]
    waits.forEach((minutes, i) => {
      const spends = unanswered(i + 1, minutes * MINUTE - 1)
      expect(journalWaiting(spends, NOW), `${i + 1} unanswered`).toBe(true)
      expect(journalWaiting(unanswered(i + 1, minutes * MINUTE), NOW), `${i + 1} unanswered, over`).toBe(false)
    })
    expect(journalWaiting(unanswered(64, HOUR), NOW)).toBe(false)
  })

  it('counts a void toward the wait, an offline spend not, and goes by the newest entry whatever the order', () => {
    expect(journalWaiting([entry({ kind: 'void', at: NOW - 1000 })], NOW)).toBe(true)
    expect(journalWaiting([entry({ kind: 'offline', at: NOW })], NOW)).toBe(false)
    expect(journalWaiting([entry({ id: 'a'.repeat(22), kind: 'unanswered', at: NOW - 1000 }), entry({ id: 'b'.repeat(22), kind: 'unanswered', at: NOW - 3 * HOUR })], NOW)).toBe(true)
  })

  it('judges the journal’s wait by the guarded clock and the other by the device clock', () => {
    const state = { spends: unanswered(1, 2 * MINUTE), backoffSince: NOW - 10 * 86_400_000 - 1000, backoffMs: RETRY_UNANSWERED_MS }
    expect(asks({ spends: state.spends }, { clockNow: NOW - 10 * 86_400_000 })).toBe(true)
    expect(asks(state, { clockNow: NOW - 10 * 86_400_000 })).toBe(false)
  })

  it('asks, whatever the waits, a spend the allowance would refuse; and one it covers only when no wait runs', () => {
    const waiting = { backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS, spends: unanswered(1, 1000) }
    expect(asks(waiting, { covered: true })).toBe(false)
    expect(asks(waiting, { covered: false })).toBe(true)
    expect(asks({}, { covered: false })).toBe(true)
  })

  it('gives the uncovered spend a wait of its own: a void opened less than a minute ago, none ahead of either clock', () => {
    const voided = (at: number) => [entry({ kind: 'void', at })]
    expect(voidWaiting(voided(NOW - RETRY_UNANSWERED_MS + 1), NOW, NOW)).toBe(true)
    expect(voidWaiting(voided(NOW - RETRY_UNANSWERED_MS), NOW, NOW)).toBe(false)
    expect(voidWaiting(voided(NOW + 1), NOW, NOW)).toBe(false)
    expect(voidWaiting([entry({ kind: 'unanswered', at: NOW }), entry({ kind: 'offline', at: NOW })], NOW, NOW)).toBe(false)
    const waiting = { spends: voided(NOW - 1000), backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS }
    expect(asks(waiting, { covered: false })).toBe(false)
    expect(asks({ spends: unanswered(1, 1000) }, { covered: false })).toBe(true)
  })

  it('needs the device clock at or after the void too: a clock set back ends the wait, one far ahead leaves it to the guarded minute', () => {
    const voided = [entry({ kind: 'void', at: NOW - 1000 })]
    // The device clock at the void's stamp is a wait; a millisecond before it is none, however recent the guarded clock says it is.
    expect(voidWaiting(voided, NOW, NOW - 1000)).toBe(true)
    expect(voidWaiting(voided, NOW, NOW - 1001)).toBe(false)
    expect(voidWaiting(voided, NOW, NOW - 10 * 86_400_000)).toBe(false)
    // A device clock far ahead does not stretch the wait: the guarded clock measures the minute.
    expect(voidWaiting(voided, NOW, NOW + 10 * 86_400_000)).toBe(true)
    expect(voidWaiting(voided, NOW + RETRY_UNANSWERED_MS, NOW + 10 * 86_400_000)).toBe(false)
    // One void at the device clock is enough, whatever a newer void ahead of it says.
    const two = [entry({ id: 'a'.repeat(22), kind: 'void', at: NOW - 30_000 }), entry({ id: 'b'.repeat(22), kind: 'void', at: NOW - 1000 })]
    expect(voidWaiting(two, NOW, NOW - 20_000)).toBe(true)
    expect(voidWaiting(two, NOW, NOW - 40_000)).toBe(false)
    const waiting = { spends: voided, backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS }
    expect(asks(waiting, { covered: false })).toBe(false)
    expect(asks(waiting, { covered: false, clockNow: NOW - 1001 })).toBe(true)
  })

  it('leaves out of a wait only the entries ahead of the clock: not their count, not their time', () => {
    const behind = (id: string, at: number) => entry({ id: id.repeat(22), kind: 'unanswered', at })
    const ahead = behind('z', NOW + 86_400_000)
    expect(journalWaiting([behind('a', NOW - 30_000), ahead], NOW)).toBe(true)
    expect(journalWaiting([behind('a', NOW - 2 * MINUTE), ahead], NOW)).toBe(false)
    // Two behind wait two minutes; counted with the one ahead they would wait four.
    expect(journalWaiting([behind('a', NOW - 2 * MINUTE), behind('b', NOW - 3 * HOUR), ahead], NOW)).toBe(false)
    expect(journalWaiting([behind('a', NOW - 2 * MINUTE + 1), behind('b', NOW - 3 * HOUR), ahead], NOW)).toBe(true)
  })

  it('has no wait to measure from an entry opened after the guarded clock, and waits from one opened at it', () => {
    expect(journalWaiting([entry({ kind: 'unanswered', at: NOW })], NOW)).toBe(true)
    expect(journalWaiting([entry({ kind: 'unanswered', at: NOW + 1 })], NOW)).toBe(false)
    expect(journalWaiting([entry({ kind: 'void', at: NOW + 10 * 86_400_000 })], NOW)).toBe(false)
    expect(journalAsks([entry({ kind: 'unanswered', at: NOW + 1 })], NOW)).toBe(true)
  })

  it('has status() offer a journal that holds an entry while its wait is not running', () => {
    expect(journalAsks(undefined, NOW)).toBe(false)
    expect(journalAsks([], NOW)).toBe(false)
    expect(journalAsks([entry()], NOW)).toBe(true)
    expect(journalAsks(unanswered(1, 30_000), NOW)).toBe(false)
    expect(journalAsks(unanswered(1, MINUTE), NOW)).toBe(true)
    expect(journalAsks('junk', NOW)).toBe(false)
  })
})

describe('what a use answer does', () => {
  const input = (response: { status: number; json: unknown } | null) => ({ response, askedAt: NOW, major: 3, device: { kind: 'machine' as const, ownClaim: 'c' } })
  const meters = { exports: { left: 89, total: 100, offline: 10 } }

  it('is a spend on a 200 with spent true, with the figures stamped by the server’s time', () => {
    const o = useOutcome(input({ status: 200, json: { spent: true, meters, at: NOW + 1, spends: [{ id: 'A'.repeat(22), n: 2 }] } }))
    expect(o).toEqual({ outcome: 'spent', patch: {}, figures: { exports: { ...figure(89), at: NOW + 1 } }, confirmed: [{ id: 'A'.repeat(22), n: 2 }] })
    expect(useOutcome(input({ status: 200, json: { spent: true, meters, at: 1.5 } })).figures).toEqual({})
    expect(useOutcome(input({ status: 200, json: { spent: 'true', meters, at: NOW } })).outcome).toBe('unanswered')
  })

  it('is used-up with what the answer says is left, on any status but a 200, a 5xx and a 429', () => {
    expect(useOutcome(input({ status: 409, json: { error: 'used-up', left: 3 } }))).toMatchObject({ outcome: 'used-up', left: 3 })
    expect(useOutcome(input({ status: 400, json: { error: 'used-up', left: 0 } }))).toMatchObject({ outcome: 'used-up', left: 0 })
    expect(useOutcome(input({ status: 409, json: { error: 'used-up', left: -1 } })).left).toBeUndefined()
    expect(useOutcome(input({ status: 503, json: { error: 'used-up', left: 3 } })).outcome).toBe('unanswered')
    expect(useOutcome(input({ status: 429, json: { error: 'used-up', left: 3 } })).outcome).toBe('unanswered')
  })

  it('stores a verdict as a validate does, and a missing answer as the wait of an unanswered request', () => {
    const revoked = useOutcome(input({ status: 403, json: { error: 'revoked', spends: [{ id: 'A'.repeat(22), n: 1 }] } }))
    expect(revoked).toMatchObject({ outcome: 'refused', refusal: 'revoked', confirmed: [{ id: 'A'.repeat(22), n: 1 }] })
    expect(revoked.patch).toMatchObject({ checkedMajor: 3, backoffSince: NOW, backoffMs: ASK_AGAIN_MS, deviceKind: 'machine', refused: 'revoked' })
    expect(useOutcome(input(null)).patch).toEqual({ backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS, deviceKind: 'machine' })
    expect(useOutcome(input({ status: 500, json: null })).patch).toEqual({})
  })
})

describe('the reports', () => {
  it('are the journal oldest first with a void marked, none for none, and at most 64', () => {
    expect(spendsReported([])).toBeUndefined()
    expect(spendsReported([entry({ kind: 'void' }), entry({ id: 'B'.repeat(22), kind: 'unanswered' })])).toEqual([
      { id: 'AAAAAAAAAAAAAAAAAAAAAA', meter: 'exports', n: 1, at: NOW, void: true },
      { id: 'B'.repeat(22), meter: 'exports', n: 1, at: NOW },
    ])
    const many = Array.from({ length: MAX_PENDING_SPENDS + 3 }, (_, i) => entry({ id: String(i).padStart(22, 'k') }))
    expect(spendsReported(many)).toHaveLength(MAX_PENDING_SPENDS)
  })

  it('are confirmed by an answer that is not a 5xx, a 429 or none, read leniently', () => {
    const body = { spends: [{ id: 'a', n: 2 }, { id: 'b', void: true }, { id: 'c', n: 0 }, { n: 1 }, 'x', { id: 'd', n: 1.5 }, { id: 'e', void: 'true' }] }
    expect(spendsConfirmed({ status: 200, json: body })).toEqual([{ id: 'a', n: 2 }, { id: 'b', void: true }])
    expect(spendsConfirmed({ status: 403, json: body })).toHaveLength(2)
    for (const status of [500, 503, 429]) expect(spendsConfirmed({ status, json: body })).toEqual([])
    expect(spendsConfirmed(null)).toEqual([])
    expect(spendsConfirmed({ status: 200, json: { spends: 'x' } })).toEqual([])
  })
})

describe('the journal’s landing', () => {
  it('grows one offline entry for each meter and opens the others once by id', () => {
    const grown = journaled(journal([entry({ n: 3 })]), offline(2, { id: 'X'.repeat(22), at: NOW + 5 }), NOW)
    expect(grown.spends).toEqual([entry({ n: 5 })])
    const twice = journaled(journal([entry({ kind: 'unanswered' })]), { kind: 'unanswered', about: A, id: 'AAAAAAAAAAAAAAAAAAAAAA', meter: 'exports', n: 9, at: NOW }, NOW)
    expect(twice.spends).toEqual([entry({ kind: 'unanswered' })])
  })

  it('refuses a spend that would take its meter’s unsynced past its limit, counting both kinds and no void, and holds a void to none', () => {
    const held = journal([entry({ n: 3 }), entry({ id: 'B'.repeat(22), n: 2, kind: 'unanswered' }), entry({ id: 'C'.repeat(22), n: 50, kind: 'void' }), entry({ id: 'D'.repeat(22), meter: 'renders', n: 9 })])
    expect(journaled(held, offline(5, { limit: 10 }), NOW).refused).toBe(false)
    expect(journaled(held, offline(6, { limit: 10 }), NOW)).toMatchObject({ refused: true, spends: held.spends })
    expect(journaled(held, { kind: 'void', about: A, id: 'V'.repeat(22), meter: 'exports', n: 6, at: NOW, limit: 0 }, NOW).refused).toBe(false)
    // A spend whose id the journal holds is left as it is, whatever its limit says now.
    const again: JournalOp = { kind: 'unanswered', about: A, id: 'B'.repeat(22), meter: 'exports', n: 9, at: NOW, limit: 1 }
    expect(journaled(held, again, NOW)).toMatchObject({ refused: false, spends: held.spends })
  })

  it('lands a spend the customer was told was made past its limit and the cap, and never refuses it', () => {
    const full = Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: String(i).padStart(22, 'k'), meter: `m${i}`, kind: 'unanswered' }))
    const landed = journaled(journal(full), offline(1, { told: true }), NOW)
    expect(landed.refused).toBe(false)
    expect(landed.spends).toHaveLength(MAX_PENDING_SPENDS + 1)
    expect(journaled(journal([entry({ n: 3 })]), offline(9, { limit: 5, told: true }), NOW).spends[0]).toMatchObject({ n: 12 })
  })

  it('keeps MAX_PENDING_VOIDS voids, a new one taking the place of the oldest, and never refuses for it', () => {
    const voids = Array.from({ length: MAX_PENDING_VOIDS }, (_, i) => entry({ id: String(i).padStart(22, 'v'), kind: 'void', at: NOW - 1000 + i }))
    const next: JournalOp = { kind: 'void', about: A, id: 'N'.repeat(22), meter: 'exports', n: 1, at: NOW }
    const landed = journaled(journal(voids.slice(1)), next, NOW)
    expect(landed.spends).toHaveLength(MAX_PENDING_VOIDS)
    const replaced = journaled(journal(voids), next, NOW)
    expect(replaced.refused).toBe(false)
    expect(replaced.spends.map((e) => e.id)).toEqual([...voids.slice(1).map((e) => e.id), 'N'.repeat(22)])
    // A void in a full journal that holds fewer voids than that is refused, as any spend is.
    const crowd = Array.from({ length: MAX_PENDING_SPENDS - 1 }, (_, i) => entry({ id: String(i).padStart(22, 'k'), meter: `m${i}`, kind: 'unanswered' }))
    expect(journaled(journal([entry({ id: 'V'.repeat(22), kind: 'void' }), ...crowd]), next, NOW).refused).toBe(true)
    // A void marked told is held to all of it, as any void (a void is never told); an unanswered spend is held to no void cap.
    expect(journaled(journal(voids), { ...next, told: true }, NOW).spends.map((e) => e.id)).toEqual(replaced.spends.map((e) => e.id))
    expect(journaled(journal([entry({ id: 'V'.repeat(22), kind: 'void' }), ...crowd]), { ...next, told: true }, NOW).refused).toBe(true)
    expect(journaled(journal(voids), { ...next, kind: 'unanswered' }, NOW).spends).toHaveLength(MAX_PENDING_VOIDS + 1)
  })

  it('refuses an append past 64 entries, and lets an open entry grow', () => {
    const full = Array.from({ length: MAX_PENDING_SPENDS }, (_, i) => entry({ id: String(i).padStart(22, 'k'), meter: `m${i}`, kind: 'unanswered' }))
    expect(journaled(journal(full), offline(1), NOW).refused).toBe(true)
    expect(journaled(journal([entry({ n: 3 }), ...full.slice(1)]), offline(1), NOW)).toMatchObject({ refused: false })
  })

  it('drops an entry by the count the server recorded, a void by a void, and keeps what grew meanwhile', () => {
    const at = (spends: ReturnType<typeof entry>[], entries: Extract<JournalOp, { kind: 'confirmed' }>['entries']) => journaled(journal(spends), { kind: 'confirmed', about: A, entries }, NOW).spends
    expect(at([entry({ n: 3 })], [{ id: entry().id, n: 3 }])).toEqual([])
    expect(at([entry({ n: 3 })], [{ id: entry().id, n: 9 }])).toEqual([])
    expect(at([entry({ n: 5 })], [{ id: entry().id, n: 3 }])).toEqual([entry({ n: 5 })])
    expect(at([entry({ kind: 'void' })], [{ id: entry().id, void: true }])).toEqual([])
    expect(at([entry({ kind: 'void' })], [{ id: entry().id, n: 1 }])).toEqual([entry({ kind: 'void' })])
    expect(at([entry({ kind: 'unanswered' })], [{ id: entry().id, void: true }])).toEqual([entry({ kind: 'unanswered' })])
  })

  it('keeps the newer figure of each meter, and nothing about another activation', () => {
    const stored = { exports: { ...figure(70), at: NOW } }
    const op = (at: number): JournalOp => ({ kind: 'figures', about: A, figures: { exports: { ...figure(50), at } } })
    expect(journaled({ activationId: A, meterFigures: stored }, op(NOW + 1), NOW).meterFigures.exports?.left).toBe(50)
    expect(journaled({ activationId: A, meterFigures: stored }, op(NOW), NOW).meterFigures.exports?.left).toBe(70)
    expect(journaled({ activationId: A, meterFigures: stored }, op(NOW - 1), NOW).meterFigures.exports?.left).toBe(70)
    expect(journaled({ activationId: 'act_2', meterFigures: stored }, op(NOW + 1), NOW).meterFigures.exports?.left).toBe(70)
    expect(journaled({ meterFigures: stored }, op(NOW + 1), NOW).meterFigures.exports?.left).toBe(70)
  })

  it('clears both for another seat or a deactivation and keeps them for the same seat', () => {
    const held = { activationId: A, spends: [entry()], meterFigures: { exports: { ...figure(70), at: NOW } } }
    expect(journaled(held, { kind: 'activated', about: 'act_2' }, NOW)).toMatchObject({ spends: [], meterFigures: {} })
    expect(journaled(held, { kind: 'activated', about: A }, NOW)).toMatchObject({ spends: [entry()] })
    expect(journaled(held, { kind: 'deactivated' }, NOW)).toMatchObject({ spends: [], meterFigures: {} })
  })

  it('drops entries opened more than 180 days ago on any op that lands, and keeps those exactly that old', () => {
    const old = entry({ id: 'O'.repeat(22), kind: 'unanswered', at: NOW - PENDING_MAX_MS - 1 })
    const edge = entry({ id: 'E'.repeat(22), kind: 'unanswered', at: NOW - PENDING_MAX_MS })
    expect(journaled(journal([old, edge]), offline(1), NOW).spends.map((e) => e.id)).toEqual(['E'.repeat(22), 'N'.repeat(22)])
    expect(journaled(journal([old]), { kind: 'confirmed', about: A, entries: [] }, NOW).spends).toEqual([])
    expect(journaled(journal([old]), offline(1, { about: 'act_2' }), NOW).spends).toEqual([old])
  })

  it('lands ops in order on a state, and is that state itself with none', () => {
    const state = journal([])
    expect(landJournal(state, [], NOW).state).toBe(state)
    const landed = landJournal(state, [offline(2), { kind: 'confirmed', about: A, entries: [{ id: 'N'.repeat(22), n: 2 }] }], NOW)
    expect(landed.state).not.toHaveProperty('spends')
    expect(landed.refused).toEqual([false, false])
  })

  it('reads a stored journal that is not one as empty', () => {
    expect(journaled({ activationId: A, spends: 'x' as never, meterFigures: 5 as never }, offline(1), NOW).spends).toEqual([entry({ id: 'N'.repeat(22), n: 1 })])
  })
})

describe('the changes a process keeps', () => {
  it('fold offline spends of one meter, figures and confirmations, and nothing across another kind of change', () => {
    const op = (n: number, meter = 'exports'): JournalOp => offline(n, { meter, id: String(n).padStart(22, 'q') })
    expect(compacted([op(1), op(2), op(3)])).toEqual([offline(6, { id: String(1).padStart(22, 'q') })])
    expect(compacted([op(1), op(2, 'renders'), op(3)])).toHaveLength(3)
    const old = { exports: { ...figure(70), at: NOW } }
    const fresh = { exports: { ...figure(50), at: NOW + 1 } }
    expect(compacted([{ kind: 'figures', about: A, figures: old }, { kind: 'figures', about: A, figures: fresh }])).toEqual([{ kind: 'figures', about: A, figures: fresh }])
    const confirmed = (n: number): JournalOp => ({ kind: 'confirmed', about: A, entries: [{ id: 'A'.repeat(22), n }] })
    expect(compacted([confirmed(2), confirmed(3)])).toEqual([{ kind: 'confirmed', about: A, entries: [{ id: 'A'.repeat(22), n: 3 }] }])
    expect(compacted([confirmed(3), confirmed(2)])).toEqual([{ kind: 'confirmed', about: A, entries: [{ id: 'A'.repeat(22), n: 3 }] }])
    expect(compacted([op(1), { kind: 'deactivated' }, op(2)])).toHaveLength(3)
    expect(compacted([op(1), offline(2, { about: 'act_2' })])).toHaveLength(2)
  })

  it('land as the ops they were folded from would', () => {
    const base = journal([])
    const ops = [offline(1, { id: 'a'.repeat(22) }), offline(2, { id: 'b'.repeat(22) }), offline(4, { id: 'c'.repeat(22) })]
    expect(landJournal(base, compacted(ops), NOW).state).toEqual(landJournal(base, ops, NOW).state)
  })
})
