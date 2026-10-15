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
}

/** A group's name. */
export type GroupName = keyof GroupInputs

/** The groups after the first ones, which come after every other group in the file (`replay-later.ts`). */
export type LaterGroup = 'majors' | 'referencedLinks' | 'trialReportDue'

/** The key-set groups, which come after the purchase groups (`replay-keys.ts`). */
export type KeyGroup = 'keyIds' | 'keySets' | 'grants'

/** The licence-file groups, which come after the key-set groups (`replay-files.ts`). */
export type FileGroup = 'licenseFileContainers' | 'licenseFiles' | 'filesAsLeases'

/** The groups before them (`replay.ts`). */
export type FirstGroup = Exclude<GroupName, LaterGroup | KeyGroup | FileGroup>

/**
 * The user-lock groups (the SDK contract, section 11), STAGED in a file
 * of their own (`sdk/conformance/user-lock.json`, `generate.ts`) until every
 * SDK answers them, when they move, unchanged, to the end of
 * `conformance/vectors.json`.
 */
export interface UserLockGroupInputs {
  /**
   * What `activate(key, options)` sends for what a person typed, or the error
   * that refuses it before anything is sent (`typedFor`); an option that was not
   * given is null.
   */
  typedFor: { email: string | null; code: string | null }
  /** The word the server refused an activation with, and the error the SDK answers (`mapServerError`). */
  userLockErrors: { error: unknown }
}

/** A user-lock group's name. */
export type UserLockGroupName = keyof UserLockGroupInputs
