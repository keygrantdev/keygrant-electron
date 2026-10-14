import type { Entitlements, LicenseFileKind } from '@keygrant/shared'

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

export type ActivateResult = { ok: true } | { ok: false; error: LicenseError }

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

/** Persisted local state (license.json equivalent). */
export interface StoredState {
  key?: string
  activationId?: string
  /** Signed JWT lease for a paid license. */
  lease?: string
  /** Earliest trial start ever seen (ms). Only ever moves earlier. */
  trialStart?: number
  /** Server-authoritative trial end (ms). */
  trialEndsAt?: number
  /** Signed JWT lease for a trial. */
  trialLease?: string
  /**
   * When (guarded device clock, ms) the trial answer stored here (its end and
   * lease) was asked for: an older answer, from another process, is not saved
   * over it, and a state without one loses to any answer that has one
   * (offline.ts `merged`).
   */
  trialAt?: number
  /** Monotonic high-water clock (ms): guards against clock rollback. */
  lastSeen?: number
  /**
   * The app major sent with the last check-in the server answered. A newer one
   * running on an open lease is reported online at once, so a key's upgrade
   * protection hears of it while its window is still open.
   */
  checkedMajor?: number
  /**
   * The newest app major run while holding a lease signed inside the key's
   * upgrade window, and only before that window's end (the lease's
   * `upgradeUntil`). Sent with every validate, so a version run offline late
   * in the window is kept by the key even if the renewal comes after it.
   */
  keptMajor?: number
  /**
   * When (device clock, ms) the last ask of the server came back without a
   * lease, and how long to wait after it (`backoffMs`): RETRY_UNANSWERED_MS when
   * nothing answered (no network, a timeout), ASK_AGAIN_MS when the server did
   * (a refusal, a 5xx, a 429, an answer the SDK could not use). Until then,
   * `status()` answers from what the device holds rather than asking again;
   * `refresh()` asks at once. Both cleared by the next lease.
   */
  backoffSince?: number
  backoffMs?: number
  /**
   * The server's definitive refusal of this key on this device: `revoked` (the
   * key revoked or expired, or this device released), stored with the lease
   * dropped; or `upgrade` / `outdated` (this build outside what the key
   * covers), stored with the lease kept and the major refused
   * (`refusedMajor`). `status()` answers it while it stands for the running
   * build, rather than licensing offline from a lease the server has refused.
   * Cleared by the next lease.
   */
  refused?: Refusal
  /** The build major an `upgrade` or `outdated` refusal was given for. */
  refusedMajor?: number
  /**
   * The device a `device` refusal was given for (its `fp` claims, hashes never
   * fingerprints): it stands only while the device is still that one, so a
   * fingerprint that flips back licenses again at once.
   */
  refusedFor?: string[]
  /**
   * What this install is keyed by: `machine` once a machine id has been read
   * here (from then on, a host-name answer is "cannot tell", never this
   * device), `hostname` when it was activated under the host name. The kind,
   * never a fingerprint: a fingerprint kept here would travel with a copied file.
   */
  deviceKind?: DeviceKind
  /**
   * When (guarded device clock, `effectiveNow`, ms) the server's answer stored
   * here was asked for: the ask that brought the lease, the refusal or the wait
   * (`backoffSince`), or an activation or deactivation. An answer asked for
   * earlier than it, by another process on this device, is not saved over it
   * (offline.ts `superseded`).
   */
  verdictAt?: number
  /**
   * When (guarded device clock, ms) a running trial last reported its launch
   * (`trial`, sent in the background by `status()`): at most once a day
   * (TRIAL_REPORT_MS), counting a trial answer (`trialAt`) as a report.
   */
  trialReportedAt?: number
  /**
   * The offline licence file this device holds (its token), as
   * `importLicenseFile` stored it. Verified again on every status, so an edit
   * to it licenses nothing. Never a key file: importing one activates its key.
   */
  licenseFile?: string
  /**
   * The default storage's revision of this state, one more on every save, so
   * a save can tell another process saved since it read (storage.ts `update`).
   */
  rev?: number
}

/** A definitive refusal from the server, as `StoredState.refused` keeps it. */
export type Refusal = 'revoked' | 'upgrade' | 'outdated' | 'device'

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
