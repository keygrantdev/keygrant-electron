/**
 * The metered-uses groups about when to ask the server (the SDK contract, 12.5): whether `use()` asks
 * (`useAsks`) and whether `status()` reports a journal to a valid lease (`syncAsks`).
 */
import { OPEN_MAJOR } from '@keygrant/shared'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from '../../src/offline.js'
import type { SpendEntry } from '../../src/meter-types.js'
import type { GroupInputs } from '../inputs.js'
import { DAY, DAY_MS, HOUR_MS, NOW, NOW_S } from './common.js'
import { spend } from './meters.js'

const MINUTE = 60_000

/** `count` entries of one kind, with distinct ids, the newest opened at `newest` and the others long before. */
function entries(kind: SpendEntry['kind'], count: number, newest: number): SpendEntry[] {
  return Array.from({ length: count }, (_, i) => spend(kind, 1, { id: String(i).padStart(22, 'k'), at: i === count - 1 ? newest : newest - 5 * HOUR_MS - i }))
}

export function useAsks(): GroupInputs['useAsks'][] {
  const c = (
    name: string,
    state: GroupInputs['useAsks']['state'],
    over: { clockNow?: number; now?: number; covered?: boolean } = {},
  ): GroupInputs['useAsks'] => ({ name, state, clockNow: over.clockNow ?? NOW, now: over.now ?? NOW, covered: over.covered ?? true })
  // A wait begun at `since`, of `ms` (a no-answer wait's by default), or of no length written (null).
  const waiting = (since: number, ms: number | null = RETRY_UNANSWERED_MS) => ({ backoffSince: since, ...(ms !== null ? { backoffMs: ms } : {}) })
  const waits = (k: number) => Math.min(ASK_AGAIN_MS, RETRY_UNANSWERED_MS * 2 ** (k - 1))
  // A journal of k unanswered spends whose newest was opened `ago` ms before now.
  const journal = (k: number, ago: number, kind: SpendEntry['kind'] = 'unanswered') => ({ spends: entries(kind, k, NOW - ago) })
  const cases: GroupInputs['useAsks'][] = [
    c('no wait and no journal: asks', {}),
    c('a no-answer wait running', waiting(NOW - 1000)),
    c('the moment of the ask itself', waiting(NOW)),
    c('a millisecond before the wait ends', waiting(NOW - RETRY_UNANSWERED_MS + 1)),
    c('the wait ends exactly now', waiting(NOW - RETRY_UNANSWERED_MS)),
    c('the wait is over', waiting(NOW - 2 * RETRY_UNANSWERED_MS)),
    c('the device clock was set back before the ask', waiting(NOW + 1000)),
    c('a wait of an hour is not a no-answer wait', waiting(NOW - 1000, ASK_AGAIN_MS)),
    c('a wait with no length is not a no-answer wait', waiting(NOW - 1000, null)),
    c('offline spends alone: no journal wait', journal(1, 0, 'offline')),
    c('an offline spend does not count toward the wait’s length', { spends: [spend('offline', 2, { id: 'o'.repeat(22), at: NOW - 90_000 }), spend('unanswered', 1, { at: NOW - 90_000 })] }),
    c('the newest entry decides, not the first listed', { spends: [spend('unanswered', 1, { id: 'a'.repeat(22), at: NOW - 3 * HOUR_MS }), spend('unanswered', 1, { id: 'b'.repeat(22), at: NOW - 30_000 })] }),
    c('the newest entry decides, though it is not the last listed', { spends: [spend('unanswered', 1, { id: 'a'.repeat(22), at: NOW - 30_000 }), spend('unanswered', 1, { id: 'b'.repeat(22), at: NOW - 3 * HOUR_MS })] }),
    c('a void counts toward the journal’s wait', journal(1, 1000, 'void')),
    c('a void, its wait ends exactly now', journal(1, waits(1), 'void')),
    c('both waits running', { ...waiting(NOW - 1000), ...journal(1, 1000) }),
    c('the first wait over, the journal’s running', { ...waiting(NOW - 2 * RETRY_UNANSWERED_MS), ...journal(1, 1000) }),
    c('the first wait running, the journal’s over', { ...waiting(NOW - 1000), ...journal(1, 2 * MINUTE) }),
    c('both waits over', { ...waiting(NOW - 2 * RETRY_UNANSWERED_MS), ...journal(1, 2 * MINUTE) }),
    c('the journal’s wait is by the guarded clock: over, though the device clock is far behind', journal(1, 2 * MINUTE), { clockNow: NOW - 10 * DAY_MS }),
    c('the first wait is by the device clock: running, though the guarded clock is far ahead', waiting(NOW - 10 * DAY_MS - 1000), { clockNow: NOW - 10 * DAY_MS, now: NOW }),
  ]
  // The journal's wait doubles with each unanswered spend, to an hour: a millisecond short of it, and over exactly.
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 20, 64]) {
    cases.push(c(`${k} unanswered, a millisecond before the wait ends`, journal(k, waits(k) - 1)))
    cases.push(c(`${k} unanswered, the wait ends exactly now`, journal(k, waits(k))))
  }
  // A mixed journal waits as k = 2, and the newest entry decides, whichever kind it is.
  cases.push(c('1 unanswered and 1 void, the void newest, a millisecond before the wait ends', mixed('void', waits(2) - 1)))
  cases.push(c('1 unanswered and 1 void, the void newest, the wait ends exactly now', mixed('void', waits(2))))
  cases.push(c('1 unanswered and 1 void, the unanswered newest, a millisecond before the wait ends', mixed('unanswered', waits(2) - 1)))
  cases.push(c('1 unanswered and 1 void, the unanswered newest, the wait ends exactly now', mixed('unanswered', waits(2))))
  // A spend the allowance would refuse asks whatever the waits: an online customer is not refused for an outage that has passed.
  cases.push(c('a spend the allowance refuses asks with no wait running', {}, { covered: false }))
  cases.push(c('a spend the allowance refuses asks though a no-answer wait is running', waiting(NOW - 1000), { covered: false }))
  cases.push(c('a spend the allowance refuses asks though the journal’s wait is running', journal(1, 1000), { covered: false }))
  cases.push(c('a spend the allowance refuses asks though both waits are running', { ...waiting(NOW - 1000), ...journal(1, 1000) }, { covered: false }))
  cases.push(c('a spend the allowance refuses asks with offline spends in the journal', journal(1, 0, 'offline'), { covered: false }))
  // The journal's wait cannot be measured from an entry opened after the guarded clock (a jump ahead, corrected): ask.
  cases.push(c('the newest entry opened at the guarded now: waits', journal(1, 0)))
  cases.push(c('the newest entry opened a millisecond after the guarded now: asks', journal(1, -1)))
  cases.push(c('the newest entry opened ten days after the guarded now: asks', journal(1, -10 * DAY_MS)))
  // An entry ahead is left out, of the count and of the newest: the others wait as they would alone.
  const behind = (ago: number, letter: string) => spend('unanswered', 1, { id: letter.repeat(22), at: NOW - ago })
  const ahead = spend('unanswered', 1, { id: 'z'.repeat(22), at: NOW + DAY_MS })
  cases.push(c('an entry ahead is left out: the older entry behind it still waits', { spends: [behind(30_000, 'a'), ahead] }))
  cases.push(c('an entry ahead is left out: the older entry behind it, past its wait, asks', { spends: [behind(2 * MINUTE, 'a'), ahead] }))
  cases.push(c('an entry ahead is left out of the count: two behind wait two minutes, which end exactly now', { spends: [behind(waits(2), 'a'), behind(3 * HOUR_MS, 'b'), ahead] }))
  cases.push(c('an entry ahead is left out of the count: two behind, a millisecond before their two minutes end', { spends: [behind(waits(2) - 1, 'a'), behind(3 * HOUR_MS, 'b'), ahead] }))
  // An uncovered spend that got no answer leaves a void, and waits a minute from it for one wait of its own.
  const voidAgo = (ago: number, letter = 'v') => spend('void', 1, { id: letter.repeat(22), at: NOW - ago })
  const uncovered = { covered: false }
  cases.push(c('an uncovered spend with a void opened a second ago waits', { spends: [voidAgo(1000)] }, uncovered))
  cases.push(c('an uncovered spend, a millisecond before the void’s minute ends: waits', { spends: [voidAgo(RETRY_UNANSWERED_MS - 1)] }, uncovered))
  cases.push(c('an uncovered spend, the void’s minute ends exactly now: asks', { spends: [voidAgo(RETRY_UNANSWERED_MS)] }, uncovered))
  cases.push(c('an uncovered spend with an older void beyond its minute and a newer inside it: waits', { spends: [voidAgo(5 * MINUTE, 'a'), voidAgo(10_000, 'b')] }, uncovered))
  cases.push(c('an uncovered spend with a void opened after the guarded now: left out, asks', { spends: [voidAgo(-1000)] }, uncovered))
  cases.push(c('an uncovered spend with a void behind its minute and one ahead: asks', { spends: [voidAgo(5 * MINUTE, 'a'), voidAgo(-1000, 'b')] }, uncovered))
  cases.push(c('an uncovered spend with an offline spend and a void long ago: asks', { spends: [spend('offline', 1, { id: 'o'.repeat(22) }), voidAgo(HOUR_MS)] }, uncovered))
  // The wait is judged by the guarded clock, and needs the device clock at or after the void: a device clock behind the guard
  // (which then stands still) never refuses an online-only meter to a customer who is online.
  cases.push(c('an uncovered spend, the device clock exactly at the void’s stamp: waits', { spends: [voidAgo(1000)] }, { ...uncovered, clockNow: NOW - 1000 }))
  cases.push(c('an uncovered spend, the device clock a millisecond behind the void’s stamp: asks', { spends: [voidAgo(1000)] }, { ...uncovered, clockNow: NOW - 1001 }))
  cases.push(c('an uncovered spend, the device clock far behind the void’s stamp, the guarded minute running: asks', { spends: [voidAgo(1000)] }, { ...uncovered, clockNow: NOW - 10 * DAY_MS }))
  cases.push(c('an uncovered spend, the device clock far ahead of the guarded clock, the guarded minute running: waits', { spends: [voidAgo(1000)] }, { ...uncovered, clockNow: NOW + 10 * DAY_MS }))
  cases.push(c('an uncovered spend, the device clock behind the newest void but at the older one: waits', { spends: [voidAgo(30_000, 'a'), voidAgo(1000, 'b')] }, { ...uncovered, clockNow: NOW - 20_000 }))
  return cases
}

/** A journal of one unanswered spend and one void, the newest (of `kind`) opened `ago` ms before now and the other long before. */
function mixed(newest: 'void' | 'unanswered', ago: number) {
  const other = newest === 'void' ? 'unanswered' : 'void'
  return { spends: [spend(other, 1, { id: 'o'.repeat(22), at: NOW - 5 * HOUR_MS }), spend(newest, 1, { id: 'n'.repeat(22), at: NOW - ago })] }
}

export function syncAsks(): GroupInputs['syncAsks'][] {
  const far = { iat: NOW_S - DAY, exp: NOW_S + 29 * DAY }
  const bounded = { major: 3, ...far }
  const open = { major: OPEN_MAJOR, ...far }
  const nearEnd = { major: 3, iat: NOW_S - 24 * DAY, exp: NOW_S + 6 * DAY }
  const c = (name: string, claims: GroupInputs['syncAsks']['claims'], state: GroupInputs['syncAsks']['state'], over: { now?: number; clockNow?: number; major?: number } = {}): GroupInputs['syncAsks'] => ({
    name,
    claims,
    state,
    major: over.major ?? 3,
    now: over.now ?? NOW,
    clockNow: over.clockNow ?? NOW,
  })
  const offline = [spend('offline', 2)]
  const unanswered = (ago: number, k = 1) => entries('unanswered', k, NOW - ago)
  return [
    c('a valid, far lease and no journal: no ask', bounded, { checkedMajor: 3 }),
    c('a journal of offline spends: ask', bounded, { checkedMajor: 3, spends: offline }),
    c('an unanswered spend inside its wait: no ask', bounded, { checkedMajor: 3, spends: unanswered(30_000) }),
    c('an unanswered spend, its wait ends exactly now: ask', bounded, { checkedMajor: 3, spends: unanswered(MINUTE) }),
    c('an unanswered spend a millisecond before its wait ends: no ask', bounded, { checkedMajor: 3, spends: unanswered(MINUTE - 1) }),
    c('a void inside its wait: no ask', bounded, { checkedMajor: 3, spends: entries('void', 1, NOW - 30_000) }),
    c('a void, its wait over: ask', bounded, { checkedMajor: 3, spends: entries('void', 1, NOW - 2 * MINUTE) }),
    c('offline and unanswered spends, the unanswered inside its wait: no ask', bounded, { checkedMajor: 3, spends: [...offline, ...unanswered(30_000)] }),
    c('two unanswered spends inside the longer wait: no ask', bounded, { checkedMajor: 3, spends: unanswered(MINUTE + 30_000, 2) }),
    c('two unanswered spends, the longer wait over: ask', bounded, { checkedMajor: 3, spends: unanswered(2 * MINUTE, 2) }),
    c('a journal and a no-answer wait running: no ask', bounded, { checkedMajor: 3, spends: offline, backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS }),
    c('a journal and a no-answer wait over: ask', bounded, { checkedMajor: 3, spends: offline, backoffSince: NOW - 2 * MINUTE, backoffMs: RETRY_UNANSWERED_MS }),
    c('a journal and an hour’s wait running: no ask', bounded, { checkedMajor: 3, spends: offline, backoffSince: NOW - 30 * MINUTE, backoffMs: ASK_AGAIN_MS }),
    c('a journal and an hour’s wait over: ask', bounded, { checkedMajor: 3, spends: offline, backoffSince: NOW - HOUR_MS, backoffMs: ASK_AGAIN_MS }),
    c('a journal and the device clock set back before the wait: ask', bounded, { checkedMajor: 3, spends: offline, backoffSince: NOW + 1000, backoffMs: ASK_AGAIN_MS }),
    c('an unanswered spend inside its wait on a lease near its end: ask', nearEnd, { checkedMajor: 3, spends: unanswered(30_000) }),
    c('an unanswered spend inside its wait and a newer build on an open lease: ask', open, { checkedMajor: 2, spends: unanswered(30_000) }),
    c('the journal’s wait is by the guarded clock: over, though the device clock is far behind', bounded, { checkedMajor: 3, spends: unanswered(2 * MINUTE) }, { clockNow: NOW - 20 * DAY_MS }),
    c('a journal that is empty is no reason', bounded, { checkedMajor: 3, spends: [] }),
    c('1 unanswered and 1 void, a millisecond before the wait ends: no ask', bounded, { checkedMajor: 3, ...mixed('void', 2 * MINUTE - 1) }),
    c('1 unanswered and 1 void, the wait ends exactly now: ask', bounded, { checkedMajor: 3, ...mixed('void', 2 * MINUTE) }),
    c('the newest entry opened a millisecond after the guarded now: ask', bounded, { checkedMajor: 3, spends: unanswered(-1) }),
    c('an entry ahead is left out: the older entry behind it still waits: no ask', bounded, { checkedMajor: 3, spends: [...unanswered(30_000), spend('unanswered', 1, { id: 'z'.repeat(22), at: NOW + DAY_MS })] }),
    c('an entry ahead is left out: the older entry behind it, past its wait: ask', bounded, { checkedMajor: 3, spends: [...unanswered(2 * MINUTE), spend('unanswered', 1, { id: 'z'.repeat(22), at: NOW + DAY_MS })] }),
  ]
}
