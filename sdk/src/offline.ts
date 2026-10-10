/**
 * What the SDK's engine (license.ts) decides from what the device holds,
 * without asking the server: whether a lease licenses this build, what a trial
 * shows, which refusal still stands, and when to ask the server again.
 */
import type { Entitlements, LeaseClaims, VerifyResult } from '@keygrant/shared'
import type { DeviceKind, LicenseStatus, Refusal, StoredState } from './types.js'
import type { Device } from './device.js'
import { entitled, sameKey } from './wire.js'

// The clock guard's decisions live in clock.ts, the key comparison in wire.ts,
// and how a save lands on the stored state in merge.ts; named here too, where
// the SDK's other offline decisions are.
export { CLOCK_TOLERANCE_MS, clockCorrection, guardedNow, savedLastSeen, type SignedAt } from './clock.js'
export { sameKey } from './wire.js'
export { merged, outdated, superseded, trialOnly, withoutVerdict, type Asked, type Basis, type Stamp } from './merge.js'

const DAY_MS = 86_400_000

/**
 * How long after the server answered without a lease (a refusal, a 5xx, a 429,
 * an answer the SDK could not use) before the SDK asks again on its own: the
 * answer rarely changes faster, and asking on every `status()` costs the app a
 * round trip and the server a request each time. `refresh()` asks at once.
 */
export const ASK_AGAIN_MS = 60 * 60_000

/**
 * How long after an ask that got no answer at all (no network, a timeout)
 * before the SDK asks again on its own. Short: the device is most likely just
 * offline, and once it is back the next `status()` should find out at once,
 * not an hour later.
 */
export const RETRY_UNANSWERED_MS = 60_000

/**
 * How often, at most, a running trial reports its launch (trials.ts
 * `trialReportDue`), a trial answer (`trialAt`) counting as one.
 */
export const TRIAL_REPORT_MS = DAY_MS

/**
 * A valid lease is renewed early, by `status()`, once less than this is left
 * of it, or less than half its own life if that is shorter (`renewsEarly`), so
 * a lease rarely runs out while the device happens to be offline.
 */
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000

/**
 * The major a build runs as: the configured one, read as the server reads a
 * version (0.x as 1, and majors from 1 up). So a build configured as major 0 is
 * major 1 everywhere the SDK uses the major (sent with `activate` and
 * `validate`, and judged by `checkLease`, `keptWith` and `standingRefusal`),
 * rather than refused offline as `outdated` by every lease. Absent is 1, a
 * fraction is cut to its whole part first, and a value that is not a finite
 * number is 1.
 */
export function majorOf(configured: number | undefined): number {
  const whole = Math.trunc(configured ?? 1)
  return Number.isFinite(whole) ? Math.max(1, whole) : 1
}

/** What a lease says about this build, offline. */
export type LeaseCheck =
  | { ok: true; test: boolean; claims: LeaseClaims }
  | { ok: false; reason: 'expired' | 'upgrade' | 'outdated' | 'tampered' | 'unknown-key' | 'device' }

/** Whose a licence lease must be: the key and activation stored, and this device (device.ts). */
export interface LeaseHolder {
  key: string
  activationId: string
  /** Every `fp` claim this device answers to: its own, and the host-name one it may have been activated under. */
  claims: string[]
  /** Whether this run could tell who the device is. */
  canTell: boolean
}

/**
 * A verified licence lease held to this product, this holder and this build's
 * major. Verifying the signature is necessary but not sufficient: a
 * validly-signed lease for another product must not license this app, nor one
 * for another key or another activation (`sub`, `aid`): those are `tampered`,
 * not a lease for this licence at all. Nor one for another device (`fp`, when
 * the lease carries it: one with no device claim is taken until its renewal
 * brings it): that is `device`, since the honest case is a machine that changed
 * (an OS reinstall, new hardware) as well as a licence file copied from
 * elsewhere, and either way the fix is to activate on this one. Only a lease
 * whose seat is keyed by a machine id (`fpk`) is judged so: a host name changes
 * with a rename or an architecture switch, and an honest device must never be
 * refused. Its `fp` may be any this device answers to (`claims`: the machine
 * id's, or the host name's it was activated under before). When this run cannot
 * tell who the device is (its machine id could not be read in time), the device
 * is not judged at all: a check the SDK cannot make fails in the customer's
 * favour. A build below the key's lowest major (`minMajor`, absent meaning 1)
 * is out of date; one above `major` needs an upgrade.
 */
export function checkLease(v: VerifyResult, product: string, major: number, holder: LeaseHolder): LeaseCheck {
  if (!v.valid) return { ok: false, reason: v.reason === 'expired' || v.reason === 'unknown-key' ? v.reason : 'tampered' }
  if (!forThisLicence(v.claims, product, holder)) return { ok: false, reason: 'tampered' }
  if (heldToAnother(v.claims, holder)) return { ok: false, reason: 'device' }
  if (major < (v.claims.minMajor ?? 1)) return { ok: false, reason: 'outdated' }
  if (major > v.claims.major) return { ok: false, reason: 'upgrade' }
  return { ok: true, test: v.claims.test === true, claims: v.claims }
}

/** Whether a lease's claims are this licence's: this product, and the key (without case) and activation stored. */
function forThisLicence(claims: LeaseClaims, product: string, holder: Pick<LeaseHolder, 'key' | 'activationId'>): boolean {
  return claims.product === product && sameKey(claims.sub, holder.key) && claims.aid === holder.activationId
}

/**
 * Whether a lease's claims hold it to a machine this run can tell is not this
 * device: held only when its seat is keyed by a machine id (`fp`, `fpk`
 * machine), since a host name changes with a rename or an architecture switch,
 * and judged only when this run can tell who the device is.
 */
function heldToAnother(claims: Pick<LeaseClaims, 'fp' | 'fpk'>, device: Pick<Device, 'claims' | 'canTell'>): boolean {
  if (claims.fp === undefined || claims.fpk !== 'machine' || !device.canTell) return false
  return !device.claims.includes(claims.fp)
}

/**
 * The status a stored licence lease gives, judged offline (`checkLease`), when
 * the server gives no verdict on it: licensed, with `test` only when the lease
 * says so (test licences verify like any other, signed with the product's real
 * key; the flag is how an app tells them apart, to refuse them in a release
 * build, say) and its entitlements only when it grants any (wire.ts
 * `entitled`); `expired` / `offline` once it has run out; `invalid` with the
 * reason, and the key, when it is not for this build or this device, or is
 * signed by a key the build does not carry (`unknown-key`); `invalid` /
 * `tampered`, with no key, when it is not this licence's at all. Only a lease
 * that licenses carries entitlements.
 */
export function leaseStatus(check: LeaseCheck, key: string | undefined): LicenseStatus {
  if (!check.ok) return notLicensed(check.reason, key)
  return { state: 'licensed', key, ...(check.test ? { test: true } : {}), ...entitled(check.claims.ent) }
}

/** Why a lease does not license this build (`checkLease`). */
type NotLicensed = Extract<LeaseCheck, { ok: false }>['reason']

/** The status of a lease that does not license this build, by why (`leaseStatus`): never with entitlements. */
function notLicensed(reason: NotLicensed, key: string | undefined): LicenseStatus {
  if (reason === 'expired') return { state: 'expired', reason: 'offline', key }
  if (reason === 'tampered') return { state: 'invalid', reason: 'tampered' }
  return { state: 'invalid', reason, key }
}

/**
 * Whether a licence lease is held to a machine that is not this device: its
 * seat keyed by a machine id (`fp`, `fpk` machine) that this run can tell is not
 * one of its own. Read from the claims of a lease whose signature holds, expired
 * or not: a seat does not change hands when its lease runs out. A seat that is
 * another device's is not this device's to release (`deactivate()`).
 */
export function heldElsewhere(v: VerifyResult, device: Pick<Device, 'claims' | 'canTell'>): boolean {
  const claims = v.valid ? v.claims : v.reason === 'expired' ? v.claims : undefined
  return claims !== undefined && heldToAnother(claims, device)
}

/**
 * `kept` after running `major` on a lease with these claims at `now`: raised to
 * it while the lease carries an open upgrade window (`upgradeUntil`, seconds)
 * and `now` is before its end, and left as it was after that end, so a major
 * first run once the window has closed is never reported as kept.
 */
export function keptWith(
  kept: number | undefined,
  claims: LeaseClaims,
  now: number,
  major: number,
): number | undefined {
  if (claims.upgradeUntil === undefined || now >= claims.upgradeUntil * 1000) return kept
  return Math.max(kept ?? 0, major)
}

/**
 * A trial lease, verified: a trial's (`model`), for this product, not past its
 * end, and for this device. A trial's lease names the device by its
 * fingerprint's claim hash (`aid`), which may be any this device answers to; it
 * is judged only when the trial was started under a machine id (`fpk`), and not
 * when this run cannot tell who the device is (as `checkLease`). A licence's
 * lease in the trial's place is not a trial: the server only ever signs a trial
 * lease as `model: 'trial'`.
 */
export function trialLeaseValid(v: VerifyResult, product: string, device: Pick<Device, 'claims' | 'canTell'>): boolean {
  if (!v.valid || v.claims.model !== 'trial' || v.claims.product !== product) return false
  return v.claims.fpk !== 'machine' || !device.canTell || device.claims.includes(v.claims.aid)
}

/** What a trial's status reads of its trial lease (`trialLeaseOf`). */
export interface TrialLease {
  /** Whether it is valid here (`trialLeaseValid`). */
  valid: boolean
  /** The end it was signed to (its `exp`, ms), when it is valid. */
  endsAt?: number
  /** What it grants (its `ent`), when it is valid. */
  entitlements?: Entitlements
}

/**
 * A trial lease, verified, as a trial's status reads it: whether it is valid
 * here (`trialLeaseValid`), and, when it is, the end it was signed to and its
 * entitlements. A lease that is not valid here says nothing of either.
 */
export function trialLeaseOf(v: VerifyResult, product: string, device: Pick<Device, 'claims' | 'canTell'>): TrialLease {
  if (!v.valid || !trialLeaseValid(v, product, device)) return { valid: false }
  return { valid: true, endsAt: v.claims.exp * 1000, entitlements: v.claims.ent }
}

/**
 * A trial's status from what the device holds: `leaseValid` is its trial lease,
 * checked (`trialLeaseValid`), `leaseEndsAt` the end that lease was signed to
 * (its `exp`, in ms), and `leaseEntitlements` what it grants (its `ent`), which
 * a running trial carries when there are any (wire.ts `entitled`).
 *
 * A trial runs only while its trial lease is valid. The `trialEndsAt` stored
 * beside it is the server's word too, but UNSIGNED: trusted on its own, editing
 * it in the state file was a trial that never ended, offline or not. KeyGrant
 * signs a trial lease to the trial's own end, so an honest trial holds a valid
 * one for every day it runs, and the signed end is the one shown. The stored
 * end is shown only when the lease's is not known.
 */
export function trialStatusOf(
  state: StoredState,
  now: number,
  leaseValid: boolean,
  leaseEndsAt?: number,
  leaseEntitlements?: Entitlements,
): LicenseStatus {
  // No trial evidence at all: the trial was never started, not expired.
  if (state.trialStart == null && state.trialEndsAt == null && state.trialLease == null) {
    return { state: 'unlicensed' }
  }
  if (!leaseValid) return { state: 'expired', reason: 'trial' }
  const trialEndsAt = leaseEndsAt ?? state.trialEndsAt
  const trialDaysLeft = trialEndsAt != null ? Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS)) : undefined
  return { state: 'trial', trialEndsAt, trialDaysLeft, ...entitled(leaseEntitlements) }
}

/**
 * What storing the server's refusal changes. A verdict on the KEY (`revoked`:
 * revoked, expired, or this device released) drops the lease, so nothing can
 * license the app offline from a lease the server no longer stands behind. A
 * verdict on this BUILD (`upgrade`, `outdated`) keeps the lease, with the major
 * it refused: a rollback to a build the key covers still runs offline. A
 * verdict on this DEVICE (`device`) keeps the lease too, with the device it was
 * given for (`refusedFor`: its OWN claim, not its alternates, so a later run
 * that only shares a host name with it is not refused for it): the offline
 * `fp` check already stops a copied lease, and a fingerprint that flips back
 * licenses again at once.
 */
export function refusalPatch(refused: Refusal, major: number, device: Pick<Device, 'ownClaim'>): Partial<StoredState> {
  if (refused === 'revoked') return { lease: undefined, refused, refusedMajor: undefined, refusedFor: undefined }
  if (refused === 'device') {
    return { refused, refusedMajor: undefined, refusedFor: device.ownClaim !== undefined ? [device.ownClaim] : [] }
  }
  return { refused, refusedMajor: major, refusedFor: undefined }
}

/** What a check-in with this device writes of the install's key: a machine id read here keys it (`deviceKind`). */
export function keyedBy(device: Pick<Device, 'kind'>): Partial<StoredState> {
  return device.kind === 'machine' ? { deviceKind: 'machine' } : {}
}

/** What a new lease from the server clears: any refusal, and the wait before asking again. */
export const LEASED: Partial<StoredState> = {
  refused: undefined,
  refusedMajor: undefined,
  refusedFor: undefined,
  backoffSince: undefined,
  backoffMs: undefined,
}

/** An activation the server answered with a lease that licenses this build (`activationPatch`). */
export interface Activation {
  key: string
  activationId: string
  lease: string
  /** The lease's claims. */
  claims: LeaseClaims
  /** The time the lease was judged at. */
  now: number
  /** This build's major. */
  major: number
  /** What the activation's fingerprint hashes: none for one of unknown kind. */
  kind?: DeviceKind
}

/**
 * What an activation saves (license.ts), stamped as an activation: the key,
 * the activation, the lease, the major heard, the kept major (`keptWith`), any
 * refusal and wait cleared (LEASED), and what the install is keyed by
 * (cleared for a fingerprint of unknown kind).
 */
export function activationPatch(a: Activation): Partial<StoredState> {
  return {
    key: a.key,
    activationId: a.activationId,
    lease: a.lease,
    checkedMajor: a.major,
    keptMajor: keptWith(undefined, a.claims, a.now, a.major),
    ...LEASED,
    deviceKind: a.kind,
  }
}

/** What a deactivated device keeps of its licence: nothing but its trial evidence and clock guard. */
export const UNKEYED: Partial<StoredState> = {
  key: undefined,
  activationId: undefined,
  lease: undefined,
  checkedMajor: undefined,
  keptMajor: undefined,
  // Install memory protects a current seat; with none, the next activation is free of it.
  deviceKind: undefined,
  ...LEASED,
}

/**
 * The stored refusal that still stands for a build running `major`, or null. A
 * key-level one always does. A build-level one stands for the build refused and
 * any further the same way: `upgrade` for that major and newer, `outdated` for
 * it and older. Any other build is judged on the lease, as usual.
 *
 * A build-level one stored with no `refusedMajor` (written before that field
 * was, when every refusal dropped the lease) stands for every build: which
 * build it was given for is unknown, and there is no lease left to judge any
 * other on. It lasts until the server is next asked (`askDue`).
 */
export function standingRefusal(
  state: StoredState,
  major: number,
  device?: Pick<Device, 'ownClaim' | 'canTell'>,
): Refusal | null {
  const { refused, refusedMajor } = state
  if (refused === undefined) return null
  if (refused === 'device' && state.refusedFor) return stillThatDevice(state.refusedFor, device) ? refused : null
  if (refused === 'revoked' || refused === 'device' || refusedMajor === undefined) return refused
  return (refused === 'upgrade' ? major >= refusedMajor : major <= refusedMajor) ? refused : null
}

/**
 * Whether a device refusal given for `refusedFor` stands for this run: by the
 * device's OWN claim, and only while this run can tell it is still that one,
 * so not on a run that cannot tell, and not once the fingerprint has flipped
 * back.
 */
function stillThatDevice(refusedFor: string[], device: Pick<Device, 'ownClaim' | 'canTell'> | undefined): boolean {
  const own = device?.canTell ? device.ownClaim : undefined
  return own !== undefined && refusedFor.includes(own)
}

/**
 * Whether to ask the server now: when forced (`refresh()`), when no ask has come
 * back without a lease since the last lease, or once that ask's wait is over
 * (`backoffMs`: RETRY_UNANSWERED_MS or ASK_AGAIN_MS). `clockNow` is the device
 * clock as it is, not the guarded one: the wait is courtesy, not protection,
 * and a clock set back since the ask (`clockNow` before it) asks at once
 * rather than wait out a wait it can no longer measure.
 */
export function askDue(state: StoredState, clockNow: number, force: boolean): boolean {
  const since = state.backoffSince
  if (force || since === undefined || clockNow < since) return true
  return clockNow - since >= (state.backoffMs ?? ASK_AGAIN_MS)
}

/**
 * Whether a valid lease is near enough its end at `now` to renew it early:
 * less than RENEW_WITHIN_MS left, or less than half its life if that is
 * shorter. Half its life, so a lease that is short to begin with (a 7-day
 * subscription lease, or one cut short by the key's own expiry) is not renewed
 * on every `status()`.
 */
export function renewsEarly(claims: LeaseClaims, now: number): boolean {
  const left = claims.exp * 1000 - now
  const life = (claims.exp - claims.iat) * 1000
  return left < Math.min(RENEW_WITHIN_MS, life / 2)
}
