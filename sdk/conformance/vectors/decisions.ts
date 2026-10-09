/**
 * The SDK's pure decisions on what the device holds: the kept major
 * (`kept`), early renewal (`renew`), the wait before asking again (`asks`),
 * which refusal stands (`standing`), a trial's status (`trialStatuses`), what
 * a verdict and a lease change (`refusalPatches`, `leasePatches`, `keyedBy`),
 * and whether a valid lease asks (`validLeaseAsks`, renewal.ts
 * `asksOnValidLease`).
 */
import { OPEN_MAJOR } from '@keygrant/shared'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from '../../src/offline.js'
import type { GroupInputs } from '../inputs.js'
import { DAY, DAY_MS, HOUR_MS, NOW, NOW_S, type Context } from './common.js'

export function kept(): GroupInputs['kept'][] {
  return [
    { name: 'no window: unchanged', kept: 2, upgradeUntil: null, now: NOW, major: 5 },
    { name: 'open window: raised to the build', kept: 2, upgradeUntil: NOW_S + DAY, now: NOW, major: 5 },
    { name: 'open window: never lowered', kept: 7, upgradeUntil: NOW_S + DAY, now: NOW, major: 5 },
    { name: 'open window, nothing kept yet', kept: null, upgradeUntil: NOW_S + DAY, now: NOW, major: 1 },
    { name: 'no window, nothing kept: still nothing', kept: null, upgradeUntil: null, now: NOW, major: 4 },
    { name: 'window closed exactly now: unchanged', kept: 2, upgradeUntil: NOW_S, now: NOW, major: 5 },
    { name: 'window closed a day ago: unchanged', kept: 2, upgradeUntil: NOW_S - DAY, now: NOW, major: 5 },
    { name: 'one millisecond before the window closes: raised', kept: 2, upgradeUntil: NOW_S, now: NOW - 1, major: 5 },
    { name: 'open window, nothing kept, build 0: kept 0, not nothing', kept: null, upgradeUntil: NOW_S + DAY, now: NOW, major: 0 },
  ]
}

export function renew(): GroupInputs['renew'][] {
  return [
    { name: '29 days left of 30: not yet', iat: NOW_S - DAY, exp: NOW_S + 29 * DAY, now: NOW },
    { name: '6 days left of 30: renew', iat: NOW_S - 24 * DAY, exp: NOW_S + 6 * DAY, now: NOW },
    { name: '4 days left of 7: not yet (more than half)', iat: NOW_S - 3 * DAY, exp: NOW_S + 4 * DAY, now: NOW },
    { name: '3 days left of 7: renew (under half)', iat: NOW_S - 4 * DAY, exp: NOW_S + 3 * DAY, now: NOW },
    { name: 'exactly 7 days left of 30: not yet', iat: NOW_S - 23 * DAY, exp: NOW_S + 7 * DAY, now: NOW },
    { name: '7 days left of 30, one millisecond on: renew', iat: NOW_S - 23 * DAY, exp: NOW_S + 7 * DAY, now: NOW + 1 },
    { name: 'exactly half of 7 days left: not yet', iat: NOW_S - 302_400, exp: NOW_S + 302_400, now: NOW },
    { name: 'half of 7 days, one millisecond on: renew', iat: NOW_S - 302_400, exp: NOW_S + 302_400, now: NOW + 1 },
    { name: 'already past its end: renew', iat: NOW_S - 30 * DAY, exp: NOW_S - 1, now: NOW },
  ]
}

export function asks(): GroupInputs['asks'][] {
  return [
    { name: 'forced', state: { backoffSince: NOW - 1000, backoffMs: ASK_AGAIN_MS }, clockNow: NOW, force: true },
    { name: 'never waited', state: {}, clockNow: NOW, force: false },
    { name: 'inside the wait', state: { backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS }, clockNow: NOW, force: false },
    { name: 'the moment of the ask itself', state: { backoffSince: NOW, backoffMs: RETRY_UNANSWERED_MS }, clockNow: NOW, force: false },
    { name: 'the wait is over', state: { backoffSince: NOW - 60_000, backoffMs: RETRY_UNANSWERED_MS }, clockNow: NOW, force: false },
    { name: 'no length stored: an hour, not yet', state: { backoffSince: NOW - 59 * 60_000 }, clockNow: NOW, force: false },
    { name: 'no length stored: exactly an hour', state: { backoffSince: NOW - HOUR_MS }, clockNow: NOW, force: false },
    { name: 'the clock was put back', state: { backoffSince: NOW + 1000, backoffMs: ASK_AGAIN_MS }, clockNow: NOW, force: false },
  ]
}

export function standing(ctx: Context): GroupInputs['standing'][] {
  const { ownClaim, altClaim } = ctx
  return [
    { name: 'no refusal', state: {}, major: 1, device: null },
    { name: 'revoked stands for any build', state: { refused: 'revoked' }, major: 9, device: null },
    { name: 'upgrade for this build', state: { refused: 'upgrade', refusedMajor: 4 }, major: 4, device: null },
    { name: 'upgrade for a newer build', state: { refused: 'upgrade', refusedMajor: 4 }, major: 5, device: null },
    { name: 'upgrade, rolled back to an older build', state: { refused: 'upgrade', refusedMajor: 4 }, major: 3, device: null },
    { name: 'outdated for this build', state: { refused: 'outdated', refusedMajor: 2 }, major: 2, device: null },
    { name: 'outdated for an older build', state: { refused: 'outdated', refusedMajor: 2 }, major: 1, device: null },
    { name: 'outdated, updated to a newer build', state: { refused: 'outdated', refusedMajor: 2 }, major: 3, device: null },
    { name: 'an upgrade refusal with no major stands for every build', state: { refused: 'upgrade' }, major: 1, device: null },
    { name: 'an outdated refusal with no major stands for every build', state: { refused: 'outdated' }, major: 7, device: null },
    { name: 'device, still that device', state: { refused: 'device', refusedFor: [ownClaim] }, major: 1, device: { ownClaim, canTell: true } },
    { name: 'device, now another', state: { refused: 'device', refusedFor: [ownClaim] }, major: 1, device: { ownClaim: altClaim, canTell: true } },
    { name: 'device, on a run that cannot tell', state: { refused: 'device', refusedFor: [ownClaim] }, major: 1, device: { canTell: false } },
    { name: 'device, and no device read at all', state: { refused: 'device', refusedFor: [ownClaim] }, major: 1, device: null },
    { name: 'device given for no device (an empty list)', state: { refused: 'device', refusedFor: [] }, major: 1, device: { ownClaim, canTell: true } },
    { name: 'device with no device recorded', state: { refused: 'device' }, major: 1, device: { ownClaim, canTell: true } },
  ]
}

export function trialStatuses(): GroupInputs['trialStatuses'][] {
  // A trial runs only on a valid trial lease, and ends at the end it was signed
  // to: the stored `trialEndsAt` is unsigned, and runs no trial on its own.
  const cases: Omit<GroupInputs['trialStatuses'], 'now'>[] = [
    { name: 'no trial evidence', state: {}, leaseValid: false, leaseEndsAt: null },
    {
      name: 'a valid trial lease, signed to the end the server stored',
      state: { trialStart: NOW - 2 * DAY_MS, trialEndsAt: NOW + 5 * DAY_MS },
      leaseValid: true,
      leaseEndsAt: NOW + 5 * DAY_MS,
    },
    {
      name: 'no lease, the stored end still ahead: no trial, the end being unsigned',
      state: { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 36 * HOUR_MS },
      leaseValid: false,
      leaseEndsAt: null,
    },
    {
      name: '25 hours left on the lease: two days',
      state: { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 25 * HOUR_MS },
      leaseValid: true,
      leaseEndsAt: NOW + 25 * HOUR_MS,
    },
    { name: 'the server end is exactly now', state: { trialStart: NOW - 7 * DAY_MS, trialEndsAt: NOW }, leaseValid: false, leaseEndsAt: null },
    { name: 'no lease, the server end passed', state: { trialStart: NOW - 8 * DAY_MS, trialEndsAt: NOW - 1 }, leaseValid: false, leaseEndsAt: null },
    {
      name: "a valid lease past the stored end: the lease's end stands",
      state: { trialStart: NOW - 8 * DAY_MS, trialEndsAt: NOW - DAY_MS },
      leaseValid: true,
      leaseEndsAt: NOW + HOUR_MS,
    },
    { name: 'a start only', state: { trialStart: NOW - DAY_MS }, leaseValid: false, leaseEndsAt: null },
    { name: 'a lease only, valid', state: { trialLease: 'trial-lease' }, leaseValid: true, leaseEndsAt: NOW + 3 * DAY_MS },
    { name: 'a lease only, not valid', state: { trialLease: 'trial-lease' }, leaseValid: false, leaseEndsAt: null },
    {
      name: 'a lease ending exactly now: zero days',
      state: { trialStart: NOW - 7 * DAY_MS, trialEndsAt: NOW },
      leaseValid: true,
      leaseEndsAt: NOW,
    },
    {
      name: 'a stored end edited a year out, the lease ending in two days',
      state: { trialStart: NOW - 5 * DAY_MS, trialEndsAt: NOW + 365 * DAY_MS, trialLease: 'trial-lease' },
      leaseValid: true,
      leaseEndsAt: NOW + 2 * DAY_MS,
    },
    {
      name: 'a stored end edited a year out, and no valid lease',
      state: { trialStart: NOW - 5 * DAY_MS, trialEndsAt: NOW + 365 * DAY_MS, trialLease: 'trial-lease' },
      leaseValid: false,
      leaseEndsAt: null,
    },
    {
      name: 'a valid lease whose end is not known: the stored end is shown',
      state: { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 4 * DAY_MS },
      leaseValid: true,
      leaseEndsAt: null,
    },
    { name: 'a valid lease, no end known anywhere', state: { trialLease: 'trial-lease' }, leaseValid: true, leaseEndsAt: null },
  ]
  return cases.map((t) => ({ ...t, now: NOW }))
}

export function refusalPatches(ctx: Context): GroupInputs['refusalPatches'][] {
  const { ownClaim } = ctx
  return [
    { name: 'a key verdict drops the lease', refused: 'revoked', major: 3, device: { ownClaim } },
    { name: 'an upgrade verdict keeps it, with the build', refused: 'upgrade', major: 3, device: { ownClaim } },
    { name: 'an outdated verdict keeps it, with the build', refused: 'outdated', major: 1, device: { ownClaim } },
    { name: 'a device verdict keeps it, with the device', refused: 'device', major: 1, device: { ownClaim } },
    { name: 'a device verdict on a device with no own claim', refused: 'device', major: 1, device: {} },
  ]
}

export function leasePatches(): GroupInputs['leasePatches'][] {
  return [
    { name: 'what a new lease clears', patch: 'LEASED' },
    { name: 'what deactivating leaves: trial evidence and the clock guard only', patch: 'UNKEYED' },
    { name: 'what an activation and a deactivation clear of a purchase: the token and its stamps', patch: 'NO_PURCHASE' },
  ]
}

export function keyedBy(): GroupInputs['keyedBy'][] {
  return [
    { name: 'a machine id keys the install', kind: 'machine' },
    { name: 'a host name does not', kind: 'hostname' },
    { name: 'nor a fingerprint of no kind', kind: null },
  ]
}

/**
 * Whether `status()` asks on a lease that licenses this build: a newer major
 * than the server heard on an open lease, or a lease near its end (by the
 * guarded clock, `now`), once the wait is over (by the device clock, `clockNow`).
 */
export function validLeaseAsks(): GroupInputs['validLeaseAsks'][] {
  const far = { iat: NOW_S - DAY, exp: NOW_S + 29 * DAY }
  const open = { major: OPEN_MAJOR, ...far }
  const bounded = { major: 3, ...far }
  const nearEnd = { major: 3, iat: NOW_S - 24 * DAY, exp: NOW_S + 6 * DAY }
  const at = { now: NOW, clockNow: NOW }
  const waiting = { backoffSince: NOW - 1000, backoffMs: RETRY_UNANSWERED_MS }
  return [
    { name: 'an open lease, a newer build than the server heard: ask', claims: open, state: { checkedMajor: 2 }, major: 3, ...at },
    { name: 'an open lease, the build the server heard: no ask', claims: open, state: { checkedMajor: 3 }, major: 3, ...at },
    { name: 'an open lease, an older build than the server heard: no ask', claims: open, state: { checkedMajor: 4 }, major: 3, ...at },
    { name: 'an open lease, nothing heard yet: ask', claims: open, state: {}, major: 1, ...at },
    { name: 'an open lease, nothing heard yet, build 0: no ask', claims: open, state: {}, major: 0, ...at },
    { name: 'a major past OPEN_MAJOR is open too', claims: { ...open, major: OPEN_MAJOR + 1 }, state: { checkedMajor: 2 }, major: 3, ...at },
    { name: 'a major just below OPEN_MAJOR is not open', claims: { ...open, major: OPEN_MAJOR - 1 }, state: { checkedMajor: 2 }, major: 3, ...at },
    { name: 'a bounded lease, a newer build than heard: no ask', claims: bounded, state: { checkedMajor: 2 }, major: 3, ...at },
    { name: 'a lease near its end: ask', claims: nearEnd, state: { checkedMajor: 3 }, major: 3, ...at },
    { name: 'an open lease near its end, the build heard: ask', claims: { ...nearEnd, major: OPEN_MAJOR }, state: { checkedMajor: 3 }, major: 3, ...at },
    { name: 'near its end, inside the wait: no ask', claims: nearEnd, state: { checkedMajor: 3, ...waiting }, major: 3, ...at },
    { name: 'a newer build, inside the wait: no ask', claims: open, state: { checkedMajor: 2, ...waiting }, major: 3, ...at },
    {
      name: 'a newer build, the wait over: ask',
      claims: open,
      state: { checkedMajor: 2, backoffSince: NOW - 60_000, backoffMs: RETRY_UNANSWERED_MS },
      major: 3,
      ...at,
    },
    {
      name: 'near its end, the device clock put back before the last ask: ask',
      claims: nearEnd,
      state: { checkedMajor: 3, backoffSince: NOW + 1000, backoffMs: ASK_AGAIN_MS },
      major: 3,
      ...at,
    },
    {
      name: 'near its end by the guarded clock, not by the device clock: ask',
      claims: nearEnd,
      state: { checkedMajor: 3 },
      major: 3,
      now: NOW,
      clockNow: NOW - 20 * DAY_MS,
    },
    {
      name: 'inside the wait by the device clock, though over by the guarded one: no ask',
      claims: open,
      state: { checkedMajor: 2, backoffSince: NOW - 20 * DAY_MS - 1000, backoffMs: RETRY_UNANSWERED_MS },
      major: 3,
      now: NOW,
      clockNow: NOW - 20 * DAY_MS,
    },
  ]
}

/**
 * The major a build runs as (`majorOf`): 0.x read as 1, as the server reads
 * it. The cases marked `jsOnly` hold a fraction, which no typed port's config
 * can hold; a negative is held by every signed major type.
 */
export function majors(): GroupInputs['majors'][] {
  return [
    { name: 'none configured: 1', configured: null },
    { name: '0 (a 0.x build): 1, as the server reads it', configured: 0 },
    { name: '1: 1', configured: 1 },
    { name: '2: 2', configured: 2 },
    { name: '7: 7', configured: 7 },
    { name: 'a fraction under 1: cut to 0, read as 1', configured: 0.5, jsOnly: true },
    { name: 'a fraction under 2: cut to 1', configured: 1.9, jsOnly: true },
    { name: 'a fraction over 2: cut to 2', configured: 2.7, jsOnly: true },
    { name: 'a negative: 1', configured: -3 },
    { name: 'a negative fraction: 1', configured: -0.5, jsOnly: true },
  ]
}
