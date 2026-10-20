/**
 * Each group's inputs, as its vectors in `conformance/vectors.json` carry them:
 * what the generator builds (`vectors/`) and the reference answers from
 * (`replay.ts`). JSON has no `undefined`: an input that is not there is `null`
 * (or, inside a state, an absent field). A vector's other fields are its
 * answers (`replay.ts` `GROUPS`, `outputs`).
 */
import type { LeaseClaims } from '@keygrant/shared'
import type { Basis, LeaseCheck, LeaseHolder } from '../src/offline.js'
import type { JournalOp, JournalState } from '../src/journal.js'
import type { BaseFigure, MeterFigure, SpendEntry } from '../src/meter-types.js'
import type { SignedAt } from '../src/clock.js'
import type { HostNames } from '../src/adapters.js'
import type { MachineIdReading } from '../src/machine-id.js'
import type { DeviceKind, PickedKey, Refusal, StoredState } from '../src/types.js'
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
  leasePatches: Named & { patch: 'LEASED' | 'UNKEYED' }
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
  /** `link` with `reference` as its one `client_reference_id` (`referencedLink`), as `upgradeUrl` answers it for the stored activation id. */
  referencedLinks: Named & { link: string; reference: string }
  /** Whether a running trial reports its launch at `now`, the guarded clock (`trialReportDue`). */
  trialReportDue: Named & { state: StoredState; now: number }
  /** A public key's id (`keyId`): the RFC 7638 thumbprint a lease's `kid` names it by. */
  keyIds: Named & { jwk: unknown }
  /** A lease verified at `now` against the key set `keys` (`verifyLease` of `importVerifyingKeys`), and the set's ids. */
  keySets: Named & { keys: JsonWebKey[]; token: string; now: number }
  /** Whether entitlements, read leniently (`entitlementsOf`), grant `code` (`grants`). */
  grants: Named & { ent: unknown; code: string }
  /** A licence file's content (`bytes`: canonical base64url, no padding) and the token it holds, or null (`licenseFileToken`). */
  licenseFileContainers: Named & { bytes: string }
  /**
   * A licence file's token verified against the key set `keys` (`verifyLicenseFile`
   * of `importVerifyingKeys`), judged for `product`, the build's `major` and the
   * denylist `revoked` (`checkLicenseFile`), and the status it gives stored
   * (`licenseFileStatus`).
   */
  licenseFiles: Named & { token: string; keys: JsonWebKey[]; product: string; major: number; revoked: string[] }
  /** A licence file given where a lease goes: verified and judged as `leases` does, and as a trial lease (`trialLeaseValid`). */
  filesAsLeases: LeaseVector
  /**
   * What `activate(key, options)` sends for what a person typed, or the error
   * that refuses it before anything is sent (`typedFor`); an option that was not
   * given is null.
   */
  typedFor: { email: string | null; code: string | null }
  /** The word the server refused an activation with, and the error the SDK answers (`mapServerError`). */
  userLockErrors: { error: unknown }
  /** A lease's `met` claim as JSON text (null: the lease has none), and the meters a verifier reads of it (`metersOf`). */
  meterClaims: Named & { json: string | null }
  /** A lease carrying `met`, verified and judged as `leases` does: the claim read as `metersOf` reads it. */
  meterLeases: LeaseVector
  /**
   * What `use(meter, n)` asks for (`askedFor`), or why it asks nothing; no `n` in the vector is an `n` not given.
   * `jsOnly`: an `n` that no typed port's call can hold (a fraction, a text), skipped by every typed port.
   */
  useAmounts: Named & { meter: string; n?: unknown; jsOnly?: true }
  /** The base figures of each meter (`figuresOf`): a lease's `met` as read, its `iat` (seconds) and the figures stored. */
  meterFigures: Named & { met: Record<string, BaseFigure>; iat: number; figures: Record<string, MeterFigure> }
  /** `status().meters` (`meterStatusOf`): base figures and the journal. */
  meterStatuses: Named & { figures: Record<string, BaseFigure>; spends: SpendEntry[] }
  /** Whether a spend with no answer is allowed (`offlineSpend`), and what is left. */
  offlineSpends: Named & { figures: Record<string, BaseFigure>; spends: SpendEntry[]; meter: string; n: number }
  /**
   * Whether `use()` asks the server (`useAsksNow`): the stored wait and journal, the device clock and the guarded
   * one, and whether the offline allowance covers the spend (`covered`; one it refuses always asks).
   */
  useAsks: Named & { state: Pick<StoredState, 'backoffSince' | 'backoffMs' | 'spends'>; clockNow: number; now: number; covered: boolean }
  /** Whether `status()` asks a valid lease's server (`asksOnValidLease`), as `validLeaseAsks`, with a journal. */
  syncAsks: GroupInputs['validLeaseAsks']
  /** A `use` answer, and what the SDK saves and says of it (`useOutcome`). */
  useOutcomes: Named & { response: { status: number; json: unknown } | null; askedAt: number; major: number; device: DeviceView }
  /** One change to the journal landed on the state as stored (`journaled`). */
  journals: Named & { latest: JournalState; op: JournalOp; now: number }
  /** The report a body carries for a journal (`spendsReported`). */
  spendReports: Named & { spends: SpendEntry[] }
  /** The reports an answer names as recorded (`spendsConfirmed`). */
  spendConfirmations: Named & { response: { status: number; json: unknown } | null }
  /**
   * What a pickup call sends for what a person typed, or the error that refuses
   * it before anything is sent (`pickupAsk`): `code` null is the ask for a code,
   * a code (even a blank one) a confirm.
   */
  pickupAsks: { email: string; code: string | null }
  /** A refused pickup call's body as parsed (null: none), and the error it answers (`pickupRefusal`). */
  pickupRefusals: { json: unknown }
  /** A confirm's 200 body as parsed, and the keys read of it (`pickedKeysOf`). */
  pickedKeys: { json: unknown }
  /** The key a restore activates, by its place (`chosenKey`): keys as read, the build's major, and when (ms). */
  pickupChoices: { keys: PickedKey[]; major: number; now: number }
}

/** A group's name. */
export type GroupName = keyof GroupInputs

/** The groups after the first ones, which come after every other group in the file (`replay-later.ts`). */
export type LaterGroup = 'majors' | 'referencedLinks' | 'trialReportDue'

/** The key-set groups, which come after the purchase groups (`replay-keys.ts`). */
export type KeyGroup = 'keyIds' | 'keySets' | 'grants'

/** The licence-file groups, which come after the key-set groups (`replay-files.ts`). */
export type FileGroup = 'licenseFileContainers' | 'licenseFiles' | 'filesAsLeases'

/**
 * The user-lock groups (the SDK contract, section 11), which come after the
 * licence-file groups (`replay-user-lock.ts`). They were staged in a file of
 * their own until every port answered them.
 */
export type UserLockGroup = 'typedFor' | 'userLockErrors'

/**
 * The metered-uses groups (the SDK contract, section 12), which come after the
 * user-lock groups (`replay-meters.ts`), at the end of the file. They were staged
 * in a file of their own until every port answered them. An input that is not
 * there is absent from the vector, or null where the group says so.
 */
export type MeterGroup =
  | 'meterClaims'
  | 'meterLeases'
  | 'useAmounts'
  | 'meterFigures'
  | 'meterStatuses'
  | 'offlineSpends'
  | 'useAsks'
  | 'syncAsks'
  | 'useOutcomes'
  | 'journals'
  | 'spendReports'
  | 'spendConfirmations'

/** The key-pickup groups (the SDK contract, section 13), which come after the metered-uses groups (`replay-pickup.ts`), at the end of the file. */
export type PickupGroup = 'pickupAsks' | 'pickupRefusals' | 'pickedKeys' | 'pickupChoices'

/** The groups before them (`replay.ts`). */
export type FirstGroup = Exclude<GroupName, LaterGroup | KeyGroup | FileGroup | UserLockGroup | MeterGroup | PickupGroup>
