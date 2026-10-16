/**
 * What the SDK keeps on disk (the SDK contract, section 5.5): the stored state and the refusal it records.
 * Named from types.ts too, where the SDK's other types are.
 */
import type { MeterFigure, SpendEntry } from './meter-types.js'
import type { DeviceKind } from './types.js'

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
   * The journal of this device's spends KeyGrant has not confirmed yet (`SpendEntry`), oldest first, about
   * the stored activation: reported with the next check-in, `use` or `deactivate`, and dropped only when the
   * server confirms it. At most MAX_PENDING_SPENDS entries (meters.ts).
   */
  spends?: SpendEntry[]
  /**
   * The newest figures a `use` answer gave for each meter, by code, about the stored activation: newer than
   * the stored lease's own `met` until the lease is renewed (meters.ts `figuresOf`).
   */
  meterFigures?: Record<string, MeterFigure>
  /**
   * The default storage's revision of this state, one more on every save, so
   * a save can tell another process saved since it read (storage.ts `update`).
   */
  rev?: number
}

/** A definitive refusal from the server, as `StoredState.refused` keeps it. */
export type Refusal = 'revoked' | 'upgrade' | 'outdated' | 'device'
