import type { Entitlements, LicenseFileKind } from '@keygrant/shared'
import type { MeterStatus } from './meter-types.js'
import type { StoredState } from './stored-state.js'

export type { MeterFigure, MeterStatus, SpendEntry, UseError, UseResult } from './meter-types.js'
export type { Refusal, StoredState } from './stored-state.js'

/**
 * What `status()` says of the licence. `unknown` (reason `storage`): the
 * state file could not be read just now (an antivirus scan holding it, say):
 * nothing is known either way, so keep running, and ask again shortly.
 */
export type LicenseState = 'licensed' | 'trial' | 'expired' | 'invalid' | 'unlicensed' | 'unknown'

/**
 * Why a licence does not license this build. `upgrade`: the build is NEWER than
 * the key covers (buy an upgrade). `outdated`: the build is OLDER than the key's
 * lowest version (update the app; the key is for a later version). `device`:
 * the licence was activated on another device (this machine changed, or the
 * state file was copied from another one); activate again on this one.
 * `tampered`: the lease is not for this licence at all (another key or
 * activation, another product, a bad signature). `unknown-key`: the lease is
 * signed by a key this build does not carry (`publicJwks`); asked online, the
 * server signs one with the key it uses now, which a build carrying that key
 * verifies. `storage`: the state file could not be read just now (state
 * `unknown`). `revoked-file`: the stored offline licence file is one this
 * build lists as revoked (`revokedLicenseFiles`).
 */
export type LicenseReason =
  | 'revoked'
  | 'upgrade'
  | 'outdated'
  | 'offline'
  | 'tampered'
  | 'unknown-key'
  | 'device'
  | 'trial'
  | 'storage'
  | 'revoked-file'

/** Who a licence file is licensed to: a name, an email address, or both. */
export interface LicensedTo {
  name?: string
  email?: string
}

export interface LicenseStatus {
  state: LicenseState
  reason?: LicenseReason
  /**
   * The licence key this device holds, when it holds one. On a file status
   * that is `licensed`, or `invalid` with `revoked-file`, `upgrade` or
   * `outdated`, the key the file records; absent on any other file status.
   */
  key?: string
  trialDaysLeft?: number
  trialEndsAt?: number
  /**
   * True when the license is a TEST license: one the developer made to exercise
   * their app, which lapses on its own within 30 days. It licenses the app like
   * any other; check this to refuse test licenses in a release build.
   */
  test?: boolean
  /**
   * What the licence grants beyond the base product, by name, as its lease
   * signs them (the `ent` claim): `status().entitlements?.edition === 'pro'`.
   * On a `licensed` status, from the licence's lease; on a `trial` status, from
   * the trial's. Absent on every other status, and when the lease grants none.
   * Values are flags, numbers and texts; a malformed member of the claim is
   * left out. A frozen plain object: a name that is also an `Object.prototype`
   * member (`constructor`, `toString`) reads that member when it is not
   * granted, so test such a name with
   * `Object.hasOwn(status.entitlements ?? {}, name)`, not by truthiness.
   */
  entitlements?: Entitlements
  /**
   * The key's meters, by code, as its lease signs them (the `met` claim), net of the uses this
   * device spent that KeyGrant has not heard of yet: `status().meters?.exports?.left`. On a
   * `licensed` status from a key's lease only; absent on every other status, and when the lease
   * names no meter. Works offline. A frozen plain object: a code that is also an
   * `Object.prototype` member reads that member when the key has no such meter, so test one with
   * `Object.hasOwn(status.meters ?? {}, code)`.
   */
  meters?: Readonly<Record<string, MeterStatus>>
  /**
   * `'file'` when the status rests on a stored offline licence file
   * (`importLicenseFile`), licensed or not; absent for a key's lease, a trial
   * and no licence. A file licence has no seat to deactivate: offer "Remove
   * licence file" (`removeLicenseFile`) instead.
   */
  source?: 'file'
  /**
   * Who the stored offline licence file is licensed to, as it signs it: show
   * it ("Licensed to Ada Lovelace"). On a file status that is `licensed`, or
   * `invalid` with `revoked-file`, `upgrade` or `outdated`; absent otherwise.
   */
  licensedTo?: LicensedTo
  /**
   * True when an earlier call on this `License` has not finished (an adapter
   * stuck on storage, say), so this answer comes from what is stored, with no
   * ask and no write (engine.ts `serial`). A restart clears it.
   */
  stalled?: boolean
}

export type LicenseError =
  | 'invalid-key'
  | 'limit'
  | 'revoked'
  | 'upgrade'
  /** The key is for a later version than this build: update the app. */
  | 'outdated'
  | 'network'
  | 'not-configured'
  /** Server returned a lease that failed offline verification (integrity/config error). */
  | 'invalid-lease'
  // A user-locked key asks a NEW device who it is (sdk-contract.md section 11):
  /** Ask the person for the address the key was sold to and `activate(key, { email })` again. */
  | 'user-email-required'
  /** Not the key's address (or longer than any); nothing is said of the real one. */
  | 'user-email-mismatch'
  /** A code was just mailed to that address: ask for it and `activate(key, { email, code })`. */
  | 'user-code-required'
  /** The code is wrong, expired, used or not six digits: ask again, or `activate(key, { email })` for a new one. */
  | 'user-code-invalid'
  /** Three codes were sent for the key this hour. */
  | 'too-many-codes'
  /** Too many wrong addresses or codes for the key this hour: try again later. */
  | 'too-many-attempts'
  /** The code could not be sent just now and nothing was activated: try again. */
  | 'try-again'

export type ActivateResult = { ok: true } | { ok: false; error: LicenseError }

/** What a person typed for a user-locked key (sdk-contract.md section 11): its address and, for a code key, the code. Never stored. */
export interface ActivateOptions {
  email?: string
  code?: string
}

/**
 * Why a pickup call (sdk-contract.md section 13) did not do what it asked.
 * `invalid-email`: no address, or one that cannot be one. `wrong-code`: not
 * the code mailed (or not six digits); ask again. `code-expired`: no live code
 * for the address (it expired, was used, or none was asked for); ask for a new
 * one. `too-many-attempts`: too many asks or confirms from this network, or
 * thirty wrong codes for the address this hour; wait `retryAfter` seconds when given.
 * `pickup-disabled`: the product's Key pickup is off. `try-again`: KeyGrant
 * could not take the ask just now. `network`: no answer.
 */
export type PickupError = 'invalid-email' | 'wrong-code' | 'code-expired' | 'too-many-attempts' | 'pickup-disabled' | 'try-again' | 'network'

/** What `pickUp(email)` did: the code is on its way when the address holds a key, and the answer is the same when it does not. */
export type PickUpSentResult = { ok: true; sent: true } | { ok: false; error: PickupError; retryAfter?: number }

/**
 * One key a pickup handed back: enough for the app to let the customer pick one
 * (its model, what it grants, its versions, its seats), never shown as a key.
 * Activate it with `activate(picked.key, { email, code: picked.activationCode })`,
 * or let `restoreByEmail` choose and activate one.
 */
export interface PickedKey {
  key: string
  /** 'perpetual' | 'subscription' | 'trial' | 'timed'. */
  model: string
  /** The licence model it was sold under, when it was: the name to show. */
  modelName: string | null
  /** 'active' | 'trial'. */
  state: string
  entitlements: Entitlements
  /** When it ends (ms); null for a key that does not. */
  expiresAt: number | null
  /** The majors it covers; null for a key sold without a version, which takes the version of the first build to activate it. */
  versions: { minMajor: number; maxMajor: number | null; upgradeUntil: number | null } | null
  deviceLimit: number
  activeDevices: number
  /** This device holds a seat on it already: activating it takes that seat back. */
  held: boolean
  /** The sale of several keys it is one of. */
  sale?: { id: string; index: number; size: number }
  /** The code a user-locked key's activation takes, already proven by the pickup. */
  activationCode?: string
}

/** What `pickUp(email, code)` did: the address's keys of the product, or why not. */
export type PickUpKeysResult = { ok: true; keys: PickedKey[] } | { ok: false; error: PickupError; retryAfter?: number }

/**
 * What `restoreByEmail(email, code)` did: a key of the address activated on this
 * device, or why not. `no-key`: the address holds no live key of the product;
 * `upgrade` / `outdated`: it holds keys, none for this build's major. Every
 * other error is a pickup's or an activation's.
 */
export type RestoreResult = { ok: true } | { ok: false; error: PickupError | LicenseError | 'no-key'; retryAfter?: number }

/**
 * Why a licence file was not taken (`importLicenseFile`). `malformed`: not a
 * licence file's text, or its token or claims are broken. `not-a-license-file`:
 * a signed token, but not a licence file (a lease, say). `bad-signature`: not
 * signed by the key it names. `unknown-key`: signed by a key this build does
 * not carry (`publicJwks`). `wrong-product`: another product's file.
 * `revoked-file`: listed in `revokedLicenseFiles`. `upgrade` / `outdated`: an
 * offline file that does not cover this build (newer than it covers / older).
 */
export type LicenseFileError =
  | 'malformed'
  | 'not-a-license-file'
  | 'bad-signature'
  | 'unknown-key'
  | 'wrong-product'
  | 'revoked-file'
  | 'upgrade'
  | 'outdated'

/**
 * What `importLicenseFile` did. An offline file is stored, and licenses the app
 * from then on; a key file's key is activated, as `activate(key)` would, and its
 * errors are `activate()`'s.
 */
export type ImportLicenseFileResult =
  | { ok: true; kind: LicenseFileKind; licensedTo: LicensedTo }
  | { ok: false; error: LicenseFileError | LicenseError }

/**
 * What `deactivate()` did about the seat. The local licence is dropped either
 * way; this says whether the device's seat is free for another one.
 */
export interface DeactivateResult {
  /**
   * True when KeyGrant confirmed the release (a 200), or when this device held
   * no activation to release. False when it could not be asked, or answered
   * anything else (a 5xx, a 429, a proxy's page): the seat may still be held,
   * and the app should say so (the developer's dashboard, or support, can
   * release it), not tell the customer it is free.
   */
  released: boolean
}

// --- adapters (all platform I/O lives behind these) --------------------------

export interface StorageAdapter {
  /**
   * The stored state, or null for none. `readOnly` (a call behind one that has
   * not finished): read and write nothing, not even to repair or migrate.
   */
  read(opts?: { readOnly?: boolean }): Promise<StoredState | null>
  write(state: StoredState): Promise<void>
  /**
   * Optional: save `merge` of the state as stored at the moment of saving,
   * merged again onto a newer one when another process saved in between. Used
   * for every save when present; without it a save is read, merge, write.
   */
  update?(merge: (latest: StoredState) => StoredState): Promise<void>
}

/** Survives app uninstall (e.g. Windows registry). No-op default. */
export interface RegistryStash {
  readTrialStart(): Promise<number | null>
  writeTrialStart(ms: number): Promise<void>
}

export interface Clock {
  now(): number
}

export interface Fingerprinter {
  /**
   * This device's fingerprint. A rejection, or no answer in time, is read as
   * "cannot tell this time". The default (`nodeFingerprinter`) REJECTS when the
   * machine id cannot be read, rather than answer a stand-in. A fingerprinter
   * with only `get()` says nothing of what its fingerprint hashes, so its seats
   * are NEVER held to their device: implement `identify` and report
   * `kind: 'machine'` for a stable machine id that should be.
   */
  get(): Promise<string>
  /**
   * Optional, and what the SDK uses when present: this device's fingerprint
   * (null when it cannot be read this time), what it hashes (`kind`), and any
   * other fingerprints this device has been activated under (`alternates`). A
   * wrapper around the default fingerprinter should implement this, or
   * delegate it, to keep its kind and its host-name alternate: with `get()`
   * alone, a device activated under the host name is another device to it.
   */
  identify?(opts: { timeoutMs: number }): Promise<DeviceIdentity>
}

/** What a fingerprint hashes: the operating system's machine id, or the host name. */
export type DeviceKind = 'machine' | 'hostname'

/** Who this device is, as far as can be told this time (`Fingerprinter.identify`). */
export interface DeviceIdentity {
  /** What a normal run gives, or null when it cannot be told this time. */
  fingerprint: string | null
  /**
   * What `fingerprint` hashes. Only a seat keyed by a `machine` id is held to
   * its device; absent means unknown, and such a seat never is.
   */
  kind?: DeviceKind
  /** Other fingerprints this device answers to (such as the host-name fingerprint). */
  alternates: string[]
}

/** Minimal HTTP surface. Returns parsed JSON and status; must not throw on 4xx. */
export interface HttpAdapter {
  /**
   * POST JSON. `timeoutMs`, when given, is how long this call may take before
   * it is abandoned (and throws); an adapter that ignores it is still held to
   * it for the SDK's own short checks, which time out on their own.
   */
  post(url: string, body: unknown, opts?: { timeoutMs?: number }): Promise<{ status: number; json: unknown }>
}

export interface Adapters {
  storage: StorageAdapter
  registry: RegistryStash
  clock: Clock
  fingerprint: Fingerprinter
  http: HttpAdapter
}

export interface LicenseConfig {
  /** Product slug, matching the KeyGrant product. */
  product: string
  /** KeyGrant API base, e.g. "https://api.keygrant.dev". */
  apiBaseUrl: string
  /**
   * The product's public keys (JWKs), embedded at build time for offline
   * verification: the key that signs its leases, and the next one once the
   * product has one staged (the `keys` of `GET /v1/products/<product>/pubkey`).
   * A lease naming its key (`kid`) is verified by that key; one naming none by
   * each in turn. Give this or `publicJwk`.
   */
  publicJwks?: readonly JsonWebKey[]
  /** One public key (JWK): a key set of one. Give this or `publicJwks`. */
  publicJwk?: JsonWebKey
  /**
   * Running app major version. Defaults to 1. Read as the server reads a
   * version: a 0.x build (0) runs as major 1, and a fraction is cut to its
   * whole number.
   */
  major?: number
  /** Human device name reported to the server. */
  deviceName?: string
  /**
   * Whether a licence is held to the device it was activated on (default
   * true). False for a product deployed on non-persistent, pooled VDI with
   * roaming profiles, where every session may be another machine: the SDK
   * then reports no kind for its fingerprint, so its seats are never held,
   * judges no lease by its device, and sends the server no fingerprints to
   * check. Configuration, not tampering: the device limit still counts seats.
   */
  deviceHold?: boolean
  /**
   * How long a request may take before the SDK abandons it, for every call
   * that names no shorter bound of its own (default DEFAULT_HTTP_TIMEOUT_MS,
   * 15 s). Kept by the SDK whatever the HTTP adapter does with it.
   */
  httpTimeoutMs?: number
  /**
   * The ids of licence files this build refuses (a file's `fid`): how an app
   * update stops an offline licence file that leaked, since nothing else can.
   * Matched exactly. A stored file listed here reads as `invalid` /
   * `revoked-file`; importing one is refused (`revoked-file`).
   */
  revokedLicenseFiles?: readonly string[]
  /** Adapter overrides. Any omitted adapter uses the Node default. */
  adapters?: Partial<Adapters>
}
