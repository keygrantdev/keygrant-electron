/**
 * Each group's inputs, as its vectors in `conformance/vectors.json` carry them:
 * what the generator builds (`vectors/`) and the reference answers from
 * (`replay.ts`). JSON has no `undefined`: an input that is not there is `null`
 * (or, inside a state, an absent field). A vector's other fields are its
 * answers (`replay.ts` `GROUPS`, `outputs`).
 */
import type { LeaseClaims } from '@keygrant/shared'
import type { Basis, LeaseCheck, LeaseHolder } from '../src/offline.js'
import type { SignedAt } from '../src/clock.js'
import type { HostNames } from '../src/adapters.js'
import type { MachineIdReading } from '../src/machine-id.js'
import type { DeviceKind, Refusal, StoredState } from '../src/types.js'
import type { ScriptedSource } from './scripted.js'

/** A vector with a name, which only says what it is. */
interface Named {
  name: string
}

/** A licence lease, verified at `now` and judged for this product, build and holder (`checkLease`). */
export interface LeaseVector extends Named {
  token: string
  now: number
  product: string
  major: number
  holder: LeaseHolder
}

/** A trial lease, verified at `now` and judged for this product and device (`trialLeaseValid`). */
export interface TrialVector extends Named {
  token: string
  now: number
  product: string
  device: { claims: string[]; canTell: boolean }
}

/** A device as the decisions that take one read it: what its fingerprint hashes, and its own claim. */
export interface DeviceView {
  kind: DeviceKind | null
  ownClaim: string | null
}

/** A validate's answer, and what the SDK saves and says of it (`renewalOutcome`). */
export interface RenewalVector extends Named {
  /** The answer: its HTTP status and its JSON body (null for none); null when there was no answer at all (it threw or timed out). */
  response: { status: number; json: unknown } | null
  /** The offline check of the lease a 200 carried (`checkLease`, as the leases group's expect, with the claims when ok); null when it carried none. */
  check: LeaseCheck | null
  /** When the ask was made, by the device clock. */
  askedAt: number
  /** The time the lease was judged at: the guarded clock, reconciled to the server's. */
  now: number
  /** This build's major. */
  major: number
  /** The stored key. */
  key: string
  /** The stored kept major. */
  keptMajor: number | null
  /** Who the device is, as the ask read it. */
  device: DeviceView
}

/** A claim's answer, and what the SDK saves and says of it (`claimOutcome`). */
export interface ClaimVector extends Named {
  /** The answer: its HTTP status and its JSON body; null when there was none (it threw or timed out, or no fingerprint could be sent). */
  response: { status: number; json: unknown } | null
  /** The offline check of the lease a 200 carried with a key and an activation id (as the leases group's expect, with the claims when ok); null otherwise. */
  check: LeaseCheck | null
  /** When the claim was asked, by the device clock: the wait's start (`claimAskedAt`). */
  clockNow: number
  /** The time the lease was judged at: the guarded clock, reconciled to the server's. */
  now: number
  /** This build's major. */
  major: number
  /** What the claim's fingerprint hashes; null for none (a fingerprint of no kind). */
  kind: DeviceKind | null
}

/** What a fingerprinter says (`DeviceIdentity`), as a vector carries it: no kind is null. */
export interface IdentityJson {
  fingerprint: string | null
  kind: DeviceKind | null
  alternates: string[]
}

/** Every group, by name, and what its vectors carry as inputs. Its order is not the file's (`GROUPS`). */
export interface GroupInputs {
  leases: LeaseVector
  trials: TrialVector
  fingerprintClaims: { input: string }
  fingerprints: { raw: string }
  machineFingerprints: { id: string }
  hostFingerprints: HostNames
  kept: Named & { kept: number | null; upgradeUntil: number | null; now: number; major: number }
  renew: Named & { iat: number; exp: number; now: number }
  asks: Named & { state: StoredState; clockNow: number; force: boolean }
  standing: Named & { state: StoredState; major: number; device: { ownClaim?: string; canTell: boolean } | null }
  /** `leaseEndsAt`: the end the valid trial lease was signed to (its `exp`, ms), null when not known. */
  trialStatuses: Named & { state: StoredState; now: number; leaseValid: boolean; leaseEndsAt: number | null }
  refusalPatches: Named & { refused: Refusal; major: number; device: { ownClaim?: string } }
  leasePatches: Named & { patch: 'LEASED' | 'UNKEYED' | 'NO_PURCHASE' }
  keyedBy: Named & { kind: DeviceKind | null }
  /** `patch` as JSON carries a patch: null clears a field. */
  merges: Named & { latest: StoredState; patch: Record<string, unknown>; basis: Basis | null }
  guardedNow: Named & { clockNow: number; lastSeen: number | null }
  clockCorrections: Named & {
    clockNow: number
    lastSeen: number | null
    claims: SignedAt | null
    heldIat: number | null
    key: string
    activationId: string
  }
  mapServerError: { error: unknown }
  refusalOf: { error: unknown }
  enteredKey: { input: string }
  trimDeviceName: { input: string; max: number }
  noAnswer: { status: number }
  parseLeaseBody: { body: unknown }
  parseTrialBody: { body: unknown }
  mountinfo: Named & { mountinfo: string }
  machineIds: Named & { source: ScriptedSource }
  renewals: RenewalVector
  /** `claims`: the lease's `major`, `iat` and `exp`, the rest of a valid lease's claims being any. */
  validLeaseAsks: Named & {
    claims: Pick<LeaseClaims, 'major' | 'iat' | 'exp'>
    state: StoredState
    major: number
    now: number
    clockNow: number
  }
  devices: Named & { identity: IdentityJson; installKind: DeviceKind | null; deviceHold: boolean }
  identities: Named & { reading: MachineIdReading; host: HostNames | null }
  savedLastSeen: Named & { stored: number | null; clockNow: number; guard: number | null }
  /** A stored licence lease, judged as `leases` judges one, and the status it gives with no verdict from the server (`leaseStatus`). */
  leaseStatuses: LeaseVector
  /** A stored trial (its start and its lease), the lease judged as `trials` judges one, and the trial's status (`trialStatusOf` of `trialLeaseOf`). */
  trialLeaseStatuses: TrialVector & { trialStart: number }
  /** A number as the server's JSON writes it, read as an entitlement (`entitlementsOf`): the bits of the double it gives. */
  entitlementNumbers: Named & { json: string }
  /**
   * The major a build configured as `configured` runs as (`majorOf`); null is
   * none configured. `jsOnly`: a fraction, which no typed port's config can
   * hold, so every typed port skips it. A negative is not marked: a port whose
   * major type is unsigned (Rust's `u32`) skips it by its value.
   */
  majors: Named & { configured: number | null; jsOnly?: true }
  /** The link `purchaseUrl` answers for the held purchase secret `secret` (`purchaseLink`: `referencedLink` of its reference). */
  purchaseUrls: Named & { link: string; secret: string }
  /** Whether the state's purchase token is still held at `now`, the guarded clock (`purchaseTokenKept`). */
  purchaseTokenKept: Named & { state: StoredState; now: number }
  /** Whether `status()` asks the claim, unforced: the link's freshness at `now` (guarded clock), the wait at `clockNow` (device clock) (`claimDue`). */
  claimDue: Named & { state: StoredState; clockNow: number; now: number }
  /** A claim's answer body, read (`parseClaimBody`). */
  parseClaimBody: { body: unknown }
  /** A claim's answer, and what the SDK saves and says of it (`claimOutcome`). */
  claimOutcomes: ClaimVector
  /** Whether a running trial reports its launch at `now`, the guarded clock (`trialReportDue`). */
  trialReportDue: Named & { state: StoredState; now: number }
  /** The reference a payment link carries for the purchase secret `secret` (`purchaseReference`). */
  purchaseReferences: Named & { secret: string }
  /**
   * The body a claim sends (`claimRequest`), or null when none is: the device
   * read as `deviceFrom(identity, none, deviceHold)` (no install memory: no key
   * is held), from `startTrial()` (`start`) or from `status()`/`refresh()`.
   */
  claimBodies: Named & { secret: string; identity: IdentityJson; deviceHold: boolean; deviceName: string | null; major: number; start: boolean }
}

/** A group's name. */
export type GroupName = keyof GroupInputs

/** The purchase groups, which come after every other group in the file (`replay-purchase.ts`). */
export type LaterGroup = 'majors' | 'purchaseUrls' | 'purchaseTokenKept' | 'claimDue' | 'parseClaimBody' | 'claimOutcomes' | 'trialReportDue' | 'purchaseReferences' | 'claimBodies'

/** The groups before them (`replay.ts`). */
export type FirstGroup = Exclude<GroupName, LaterGroup>
