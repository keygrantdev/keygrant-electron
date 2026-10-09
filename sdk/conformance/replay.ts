/**
 * How each group of `conformance/vectors.json` is answered by the reference,
 * from the vector's own JSON inputs: what every other SDK's harness does in its
 * own language.
 *
 * The generator (`generate.ts`) fills in every answer through these, from the
 * inputs as JSON carries them, so a vector can never hold an answer its JSON
 * cannot reproduce; the reference's suite (`src/conformance.test.ts`) replays
 * the committed file through them again.
 *
 * Conventions a port's harness follows (also stated in the file):
 *  - Times are milliseconds since the epoch; lease claims are seconds.
 *  - A state is a `StoredState` with absent fields undefined.
 *  - In a PATCH (merges' `patch`, and every patch an expect holds), `null` means
 *    the field is cleared (set to undefined), and an absent field is left alone.
 *  - A function that answers "nothing" (undefined or null) is `null` in `expect`;
 *    inside an answer, a member with no value is left out.
 */
import { entitlementsOf, fingerprintClaim, verifyLease, type LeaseClaims, type VerifyResult } from '@keygrant/shared'
import {
  LEASED,
  NO_PURCHASE,
  UNKEYED,
  askDue,
  checkLease,
  keptWith,
  keyedBy,
  leaseStatus,
  merged,
  refusalPatch,
  renewsEarly,
  standingRefusal,
  trialLeaseOf,
  trialLeaseValid,
  trialStatusOf,
} from '../src/offline.js'
import { clockCorrection, guardedNow, savedLastSeen } from '../src/clock.js'
import { asksOnValidLease, renewalOutcome, type RenewalOutcome } from '../src/renewal.js'
import { enteredKey, mapServerError, noAnswer, parseLeaseBody, parseTrialBody, refusalOf, trimToLength } from '../src/wire.js'
import { hashFingerprint, hostFingerprint, identityOf, machineFingerprint } from '../src/adapters.js'
import { machineIdFilesystem, readMachineId } from '../src/machine-id.js'
import { deviceFrom, type Device } from '../src/device.js'
import type { DeviceIdentity, DeviceKind, StoredState } from '../src/types.js'
import type { FirstGroup, GroupInputs, GroupName, IdentityJson } from './inputs.js'
import { LATER } from './replay-purchase.js'
import { scripted } from './scripted.js'

// --- JSON ---------------------------------------------------------------------

/** A patch as JSON carries it: a cleared field is `null`. */
export function encodePatch(patch: Partial<StoredState>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(patch)) out[field] = value === undefined ? null : value
  return out
}

/** A patch from JSON: `null` is a field to clear. */
export function decodePatch(json: Record<string, unknown>): Partial<StoredState> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(json)) out[field] = value === null ? undefined : value
  return out as Partial<StoredState>
}

/** A value as JSON says it: undefined members dropped, and nothing at all as null. */
export function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

/** `x ?? undefined`, for the optional inputs JSON writes as null. */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value)

// --- the claims the pure decisions read ---------------------------------------

/**
 * A valid licence lease's claims. The decisions below read one or two of them
 * (`upgradeUntil`, `iat`, `exp`, `major`); the rest only make it a whole claim set.
 */
export const BASE_CLAIMS: LeaseClaims = {
  iss: 'keygrant',
  sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD',
  product: 'sluice',
  aid: 'act_1',
  model: 'perpetual',
  lim: 3,
  major: 3,
  ent: {},
  iat: 1_789_913_600,
  exp: 1_792_505_600,
}

/** A device as the decisions read it, from what a vector gives of it. */
function deviceOf(given: { kind?: DeviceKind | null; ownClaim?: string | null; canTell?: boolean; claims?: string[] }): Device {
  const kind = opt(given.kind)
  const ownClaim = opt(given.ownClaim)
  return {
    own: given.canTell === false ? null : 'fingerprint-own',
    canTell: given.canTell ?? true,
    fingerprints: given.canTell === false ? [] : ['fingerprint-own'],
    claims: given.claims ?? (ownClaim !== undefined ? [ownClaim] : []),
    hostname: null,
    ...(kind !== undefined ? { kind } : {}),
    ...(ownClaim !== undefined ? { ownClaim } : {}),
  }
}

/** A fingerprinter's answer from a vector: no kind (null) is none. */
function identityFrom(given: IdentityJson): DeviceIdentity {
  const { fingerprint, alternates } = given
  return given.kind === null ? { fingerprint, alternates } : { fingerprint, kind: given.kind, alternates }
}

/** What verifying a lease says, claims included when it has them (valid, or merely expired). */
function verified(v: VerifyResult): unknown {
  if (v.valid) return { valid: true, claims: plain(v.claims) }
  return plain({ valid: false, reason: v.reason, claims: v.claims })
}

/** A double's IEEE-754 bits, sign first, as 16 lowercase hex digits: what no JSON reader can round. */
export function doubleBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

/** A renewal's outcome as JSON says it: the status as `plain`, the patch as a patch. */
function renewalJson(outcome: RenewalOutcome): unknown {
  return { answered: outcome.answered, status: plain(outcome.status), patch: encodePatch(outcome.patch) }
}

// --- the groups -----------------------------------------------------------------

/** How a group's vectors are answered: which of their fields are answers, and the reference's answer from the rest. */
export interface Group<I> {
  /** The fields of a vector that are answers; every other field is an input. */
  outputs: readonly string[]
  answer(input: I, key: CryptoKey): Promise<Record<string, unknown>> | Record<string, unknown>
}

/** The older groups, each answered from its inputs as `GroupInputs` types them. Order is the order of the file. */
const FIRST: { [G in FirstGroup]: Group<GroupInputs[G]> } = {
  leases: {
    outputs: ['verify', 'expect'],
    async answer(i, key) {
      const v = await verifyLease(i.token, key, i.now)
      const check = checkLease(v, i.product, i.major, i.holder)
      return { verify: verified(v), expect: check.ok ? { ok: true, test: check.test } : { ok: false, reason: check.reason } }
    },
  },
  trials: {
    outputs: ['expect'],
    async answer(i, key) {
      return { expect: trialLeaseValid(await verifyLease(i.token, key, i.now), i.product, i.device) }
    },
  },
  fingerprintClaims: {
    outputs: ['claim'],
    async answer(i) {
      return { claim: await fingerprintClaim(i.input) }
    },
  },
  fingerprints: {
    outputs: ['fingerprint'],
    answer: (i) => ({ fingerprint: hashFingerprint(i.raw) }),
  },
  machineFingerprints: {
    outputs: ['fingerprint'],
    answer: (i) => ({ fingerprint: machineFingerprint(i.id) }),
  },
  hostFingerprints: {
    outputs: ['fingerprint'],
    answer: (i) => ({ fingerprint: hostFingerprint(i.host, i.platform, i.arch) }),
  },
  kept: {
    outputs: ['expect'],
    answer: (i) => {
      const claims: LeaseClaims = { ...BASE_CLAIMS, ...(i.upgradeUntil !== null ? { upgradeUntil: i.upgradeUntil } : {}) }
      return { expect: plain(keptWith(opt(i.kept), claims, i.now, i.major)) }
    },
  },
  renew: {
    outputs: ['expect'],
    answer: (i) => ({ expect: renewsEarly({ ...BASE_CLAIMS, iat: i.iat, exp: i.exp }, i.now) }),
  },
  asks: {
    outputs: ['expect'],
    answer: (i) => ({ expect: askDue(i.state, i.clockNow, i.force) }),
  },
  standing: {
    outputs: ['expect'],
    answer: (i) => ({ expect: standingRefusal(i.state, i.major, i.device === null ? undefined : deviceOf(i.device)) }),
  },
  trialStatuses: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(trialStatusOf(i.state, i.now, i.leaseValid, i.leaseEndsAt ?? undefined)) }),
  },
  refusalPatches: {
    outputs: ['expect'],
    answer: (i) => ({ expect: encodePatch(refusalPatch(i.refused, i.major, deviceOf(i.device))) }),
  },
  leasePatches: {
    outputs: ['expect'],
    answer: (i) => ({ expect: encodePatch(i.patch === 'LEASED' ? LEASED : i.patch === 'UNKEYED' ? UNKEYED : NO_PURCHASE) }),
  },
  keyedBy: {
    outputs: ['expect'],
    answer: (i) => ({ expect: encodePatch(keyedBy(deviceOf({ kind: i.kind }))) }),
  },
  merges: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(merged(i.latest, decodePatch(i.patch), opt(i.basis))) }),
  },
  guardedNow: {
    outputs: ['expect'],
    answer: (i) => ({ expect: guardedNow(i.clockNow, opt(i.lastSeen)) }),
  },
  clockCorrections: {
    outputs: ['expect'],
    answer: (i) => ({
      expect: clockCorrection({
        clockNow: i.clockNow,
        lastSeen: opt(i.lastSeen),
        claims: opt(i.claims),
        heldIat: opt(i.heldIat),
        key: i.key,
        activationId: i.activationId,
      }),
    }),
  },
  mapServerError: {
    outputs: ['expect'],
    answer: (i) => ({ expect: mapServerError(i.error) }),
  },
  refusalOf: {
    outputs: ['expect'],
    answer: (i) => ({ expect: refusalOf(i.error) }),
  },
  enteredKey: {
    outputs: ['expect'],
    answer: (i) => ({ expect: enteredKey(i.input) }),
  },
  trimDeviceName: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(trimToLength(i.input, i.max)) }),
  },
  noAnswer: {
    outputs: ['expect'],
    answer: (i) => ({ expect: noAnswer(i.status) }),
  },
  parseLeaseBody: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(parseLeaseBody(i.body)) }),
  },
  parseTrialBody: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(parseTrialBody(i.body)) }),
  },
  mountinfo: {
    outputs: ['expect'],
    answer: (i) => ({ expect: machineIdFilesystem(i.mountinfo) }),
  },
  machineIds: {
    outputs: ['expect'],
    async answer(i) {
      return { expect: await readMachineId(scripted(i.source)) }
    },
  },
  renewals: {
    outputs: ['expect'],
    answer: (i) => ({
      expect: renewalJson(
        renewalOutcome({
          response: i.response,
          ...(i.check !== null ? { check: i.check } : {}),
          askedAt: i.askedAt,
          now: i.now,
          major: i.major,
          key: i.key,
          keptMajor: opt(i.keptMajor),
          device: deviceOf(i.device),
        }),
      ),
    }),
  },
  validLeaseAsks: {
    outputs: ['expect'],
    answer: (i) => ({
      expect: asksOnValidLease({
        claims: { ...BASE_CLAIMS, ...i.claims },
        state: i.state,
        major: i.major,
        now: i.now,
        clockNow: i.clockNow,
      }),
    }),
  },
  devices: {
    outputs: ['expect'],
    async answer(i) {
      return { expect: plain(await deviceFrom(identityFrom(i.identity), opt(i.installKind), i.deviceHold)) }
    },
  },
  identities: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(identityOf(i.reading, i.host)) }),
  },
  savedLastSeen: {
    outputs: ['expect'],
    answer: (i) => ({ expect: savedLastSeen(opt(i.stored), i.clockNow, opt(i.guard)) }),
  },
  leaseStatuses: {
    outputs: ['expect'],
    async answer(i, key) {
      const check = checkLease(await verifyLease(i.token, key, i.now), i.product, i.major, i.holder)
      return { expect: plain(leaseStatus(check, i.holder.key)) }
    },
  },
  trialLeaseStatuses: {
    outputs: ['expect'],
    async answer(i, key) {
      // The stored trial is its start and its lease: its end and its entitlements are the lease's.
      const lease = trialLeaseOf(await verifyLease(i.token, key, i.now), i.product, i.device)
      const state = { trialStart: i.trialStart, trialLease: i.token }
      return { expect: plain(trialStatusOf(state, i.now, lease.valid, lease.endsAt, lease.entitlements)) }
    },
  },
  entitlementNumbers: {
    outputs: ['expect'],
    answer: (i) => {
      const read = entitlementsOf(JSON.parse(`{"n":${i.json}}`)).n
      if (typeof read !== 'number') throw new Error(`${i.json} is not a number`)
      return { expect: doubleBits(read) }
    },
  },
}

/** Every group: the first ones, then the purchase groups (`replay-purchase.ts`), in the order of the file. */
export const ANSWERS: { [G in GroupName]: Group<GroupInputs[G]> } = { ...FIRST, ...LATER }

/**
 * The same groups as a harness reading the file sees them: a vector's inputs
 * come from JSON, which nothing but its group types. The one cast is here, at
 * that boundary; the generator's inputs are checked against `GroupInputs`
 * where they are built (`generate.ts`).
 */
export const GROUPS = ANSWERS as unknown as Readonly<Record<GroupName, Group<Record<string, unknown>>>>
