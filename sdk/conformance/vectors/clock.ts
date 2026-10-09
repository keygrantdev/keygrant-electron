/**
 * The clock guard (clock.ts): now by the guard (`guardedNow`), where a fresh
 * lease brings it back to (`clockCorrections`), and the latest time seen a save
 * writes (`savedLastSeen`).
 */
import { CLOCK_TOLERANCE_MS } from '../../src/clock.js'
import type { GroupInputs } from '../inputs.js'
import { AID, DAY, DAY_MS, HOUR_MS, KEY, NOW, NOW_S } from './common.js'

export function guardedNow(): GroupInputs['guardedNow'][] {
  return [
    { name: 'the clock ahead of the guard', clockNow: NOW, lastSeen: NOW - 1000 },
    { name: 'the clock put back behind the guard', clockNow: NOW - 5 * DAY_MS, lastSeen: NOW },
    { name: 'nothing seen yet', clockNow: NOW, lastSeen: null },
  ]
}

export function clockCorrections(): GroupInputs['clockCorrections'][] {
  const fresh = { sub: KEY, aid: AID, iat: NOW_S }
  const ahead = NOW + DAY_MS
  const cases: Omit<GroupInputs['clockCorrections'], 'key' | 'activationId'>[] = [
    { name: 'the guard a day past a fresh lease: back to the clock', clockNow: NOW + 60_000, lastSeen: ahead, claims: fresh, heldIat: NOW_S - DAY },
    { name: 'the clock still behind the signing time: back to the signing time', clockNow: NOW - HOUR_MS, lastSeen: ahead, claims: fresh, heldIat: null },
    { name: 'the guard exactly the tolerance past: left', clockNow: NOW, lastSeen: NOW + CLOCK_TOLERANCE_MS, claims: fresh, heldIat: null },
    { name: 'the guard a millisecond past the tolerance: back', clockNow: NOW, lastSeen: NOW + CLOCK_TOLERANCE_MS + 1, claims: fresh, heldIat: null },
    { name: 'a lease older than the one held: left', clockNow: NOW, lastSeen: ahead, claims: fresh, heldIat: NOW_S + 1 },
    { name: 'a lease as old as the one held: back', clockNow: NOW, lastSeen: ahead, claims: fresh, heldIat: NOW_S },
    { name: 'a lease for another key: left', clockNow: NOW, lastSeen: ahead, claims: { ...fresh, sub: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }, heldIat: null },
    { name: 'the key in another case: back', clockNow: NOW, lastSeen: ahead, claims: { ...fresh, sub: KEY.toLowerCase() }, heldIat: null },
    { name: 'a lease for another activation: left', clockNow: NOW, lastSeen: ahead, claims: { ...fresh, aid: 'act_2' }, heldIat: null },
    { name: 'a lease that did not verify: left', clockNow: NOW, lastSeen: ahead, claims: null, heldIat: null },
    { name: 'nothing seen yet: left', clockNow: NOW, lastSeen: null, claims: fresh, heldIat: null },
    { name: 'the activation id in another case: left', clockNow: NOW, lastSeen: ahead, claims: { ...fresh, aid: AID.toUpperCase() }, heldIat: null },
  ]
  return cases.map((c) => ({ ...c, key: KEY, activationId: AID }))
}

/** What a save writes as the latest time seen: the guard as given when there is one, else never earlier. */
export function savedLastSeen(): GroupInputs['savedLastSeen'][] {
  return [
    { name: 'no guard, the clock ahead of what was seen: the clock', stored: NOW - 1000, clockNow: NOW, guard: null },
    { name: 'no guard, the clock put back: what was seen', stored: NOW, clockNow: NOW - 5 * DAY_MS, guard: null },
    { name: 'no guard, nothing seen yet: the clock', stored: null, clockNow: NOW, guard: null },
    { name: 'a guard brought back below what was seen: the guard', stored: NOW + DAY_MS, clockNow: NOW, guard: NOW + 60_000 },
    { name: 'a guard below the clock: the guard, as given', stored: NOW + DAY_MS, clockNow: NOW + 2000, guard: NOW },
    { name: 'a guard with nothing seen yet: the guard', stored: null, clockNow: NOW - HOUR_MS, guard: NOW },
    { name: 'a guard of 0 is a guard', stored: NOW, clockNow: NOW + 1000, guard: 0 },
  ]
}
