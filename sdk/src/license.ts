import type { LeaseClaims } from '@keygrant/shared'
import type {
  ActivateOptions,
  ActivateResult,
  DeactivateResult,
  ImportLicenseFileResult,
  LicenseConfig,
  LicenseStatus,
  PickUpKeysResult,
  PickUpSentResult,
  Refusal,
  RestoreResult,
  StoredState,
  UseResult,
} from './types.js'
import { PickupEngine } from './pickup-engine.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { askDue, keptWith, leaseStatus, standingRefusal } from './offline.js'
import { meteredStatus } from './meters.js'
import { referencedLink } from './link.js'
import { asksOnValidLease } from './renewal.js'
import { MAX_DEVICE_NAME, STATUS_CHECK_TIMEOUT_MS, trimToLength } from './wire.js'
import { MissingEntitlementError, grants } from './entitlements.js'

/**
 * Client-side licensing for desktop apps. Verifies signed JWT leases OFFLINE and only contacts the
 * server to activate, to renew a lease nearing its end or past it, to tell it of a newer major, or
 * to report a running trial's launch (at most once a day), so a transient outage never locks out a paying customer while the lease is live (the
 * grace window is the lease's lifetime). Trial start is anti-reset (only moves earlier) and a
 * monotonic clock guard prevents rewinding time to resurrect expired leases.
 *
 * When `status()` goes online (each at most once per wait, `askDue`; `refresh()`
 * always does):
 *  - a valid lease: when this build is a newer major than the server last
 *    heard, on an open lease, when the lease is nearing its end
 *    (`renewsEarly`), or when the device holds spends KeyGrant has not heard of
 *    (the journal, spend.ts) and its own wait is not running; bounded by
 *    STATUS_CHECK_TIMEOUT_MS, and the valid lease is the answer when that gets no
 *    verdict;
 *  - a lease past its end or otherwise invalid here, and a stored refusal that
 *    stands for this build: to give the server the chance to heal it;
 *  - a trial whose lease does not verify here while its stored end is still
 *    ahead (a lease signed before the product's key was rotated, say): the
 *    trial is asked for again, bounded by STATUS_CHECK_TIMEOUT_MS (`healTrial`);
 *  - a running trial: its launch reported, at most once a day, in the
 *    background and never awaited (trials.ts `reportLaunch`).
 *
 * A stored offline licence file that licenses this build answers before all
 * of that, and never goes online (files.ts).
 */
export class License extends PickupEngine {
  /** The device name an activation reports, cut to what the server takes. */
  protected readonly deviceName: string | undefined

  constructor(config: LicenseConfig) {
    super(config)
    /**
     * TRUNCATED, because the integrating app supplies it.
     *
     * The activate endpoint bounds every string it takes (it is public and
     * unauthenticated), so a long device name would turn a first activation into
     * a 400, which the SDK maps to `network`. The name is a label in a device
     * list; cutting it is better than refusing the activation it is attached to.
     */
    this.deviceName = trimToLength(config.deviceName, MAX_DEVICE_NAME)
  }

  // --- public API ------------------------------------------------------------

  /**
   * Activate a license key on this device.
   *
   * A key whose licence model is user-locked asks a NEW device who it is, and only a new
   * device: `options.email` is the address the key was sold to, and, for a key that mails a
   * code, `options.code` is the code that came to it. The first activation of such a key is
   * answered `user-email-required`; with the address, `user-code-required` (a code was sent) or
   * a lease; with the code, a lease. Neither is stored. A key that is not locked ignores both once they reach
   * the server, but an address longer than any email, or a code that is not six digits, is refused here
   * for any key (`user-email-mismatch`, `user-code-invalid`), and a value that is neither text nor a number is ignored.
   */
  activate(key: string, options?: ActivateOptions | null): Promise<ActivateResult> {
    // Behind a call that has not settled (engine.ts `serial`), nothing may be
    // written: the activation is answered as not reaching the server, to retry.
    return this.serial(async (readOnly) => (readOnly ? { ok: false, error: 'network' } : this.activateNow(key, options ?? {})))
  }

  /**
   * Key pickup (sdk-contract.md section 13), for a build that may not take a
   * typed key (an App Store build): with an address alone, ask KeyGrant to mail
   * a code to it, answered the same whether or not it holds a key of the
   * product; with the code that came, that address's live keys of the product,
   * for the app to let the customer pick one by its model (never shown as a
   * key). Needs the product's Key pickup on (`pickup-disabled` otherwise).
   * Writes nothing and never rejects; `restoreByEmail` confirms and activates
   * in one call.
   */
  pickUp(email: string): Promise<PickUpSentResult>
  pickUp(email: string, code: string): Promise<PickUpKeysResult>
  pickUp(email: string, code?: string): Promise<PickUpSentResult | PickUpKeysResult> {
    return code === undefined ? this.requestPickup(email) : this.confirmPickup(email, code)
  }

  /**
   * Confirm a pickup's code and activate, on this device, the key of the
   * address that fits this build: the one it already holds a seat on, else one
   * with a free seat, else the first (sdk-contract.md section 13). The key is
   * never handed to the app. A user-locked key activates with the address, and
   * a code-locked one with the code the pickup proved, so nothing more is asked.
   * Answers `no-key` when the address holds none, `upgrade` or `outdated` when
   * none covers this build, and otherwise as `pickUp(email, code)` and
   * `activate()` do; rejects only where `activate()` does.
   */
  restoreByEmail(email: string, code: string): Promise<RestoreResult> {
    return this.serial(async (readOnly) => (readOnly ? { ok: false, error: 'network' } : this.restoreNow(email, code)))
  }

  /**
   * `paymentLinkUrl` with this device's ACTIVATION id added as
   * `client_reference_id`, or null when the device holds no activated licence.
   * Send a customer there to buy an upgrade for the key they hold: a checkout for
   * an upgrade offer finds their key through the activation and extends it rather
   * than minting a second one.
   *
   * The activation id, and never the licence key: a URL lands in browser
   * history, in logs and in the tenant's Stripe session, and the activation id
   * grants nothing on its own (validating needs the key as well).
   */
  async upgradeUrl(paymentLinkUrl: string): Promise<string | null> {
    // Read-only: this runs outside the one-at-a-time order, beside any call.
    const { key, activationId } = await this.load(true)
    if (!key || !activationId) return null
    return referencedLink(paymentLinkUrl, activationId)
  }

  /**
   * Release this device's activation and drop the local license, saying whether
   * the seat is now free (`released`). Rejects, releasing nothing, when a call
   * before it has not settled (engine.ts `serial`): the local licence cannot be
   * dropped safely until it has. Rejects too, the key kept, when the local state
   * cannot be saved: the server may already have freed the seat, so the app
   * should offer to try again, and a second call answers `released: true` (the
   * server's deactivate is idempotent).
   */
  deactivate(): Promise<DeactivateResult> {
    return this.serial(async (readOnly) => {
      if (readOnly) throw new Error('a previous licence call has not finished; try again')
      return this.deactivateNow()
    })
  }

  /**
   * Take a licence file the customer was sent (`.kglicense`), as text or as
   * bytes, as a drag-and-drop handler or an open dialog gets it: its content,
   * never its path. Verified offline against the build's key set, for this
   * product and, for an offline file, this build's major; refused when
   * `revokedLicenseFiles` lists it. An OFFLINE file is then stored and licenses
   * the app with no network, ever (`status()` gives `source: 'file'`). A KEY
   * file's key is activated online exactly as `activate(key)` would, and its
   * errors are `activate()`'s. Rejects when a call before it has not settled,
   * when an offline file cannot be saved, and for a key file wherever
   * `activate()` rejects; refuses, with a distinct error, anything else. A key file of a
   * user-locked key takes `options` as `activate(key, options)` does.
   */
  importLicenseFile(content: string | Uint8Array | ArrayBuffer, options?: ActivateOptions | null): Promise<ImportLicenseFileResult> {
    return this.serial(async (readOnly) => {
      if (readOnly) throw new Error('a previous licence call has not finished; try again')
      return this.importFile(content, (key) => this.activateNow(key, options ?? {}))
    })
  }

  /**
   * Drop the stored offline licence file, if there is one; a key this device
   * holds keeps working. Rejects when a call before it has not settled, or when
   * that cannot be saved.
   */
  removeLicenseFile(): Promise<void> {
    return this.serial(async (readOnly) => {
      if (readOnly) throw new Error('a previous licence call has not finished; try again')
      return this.removeFile()
    })
  }

  /** Re-check licensing: renews the lease online, whatever the waits say. */
  async refresh(): Promise<LicenseStatus> {
    return this.status(true)
  }

  /**
   * Current licensing status. Offline-first; only calls out when forced or
   * needed. Never rejects for storage: a state that cannot be read just now is
   * `unknown` (reason `storage`), with no ask and no write, and a save that
   * fails leaves the answer standing (engine.ts `saveBestEffort`). An app
   * awaits it at launch: a rejection there is no window, or an activation
   * screen shown to a paying customer.
   */
  status(forceOnline = false): Promise<LicenseStatus> {
    return this.serial(async (readOnly) => {
      if (!readOnly) {
        await this.saveUnsavedTrial()
        await this.saveUnsavedJournal()
      }
      const state = await this.loadForStatus(readOnly)
      const status = state ? await this.statusNow(state, forceOnline, readOnly) : { ...UNREADABLE }
      // Answered from storage behind a call that has not finished: say so.
      return readOnly ? { ...status, stalled: true } : status
    })
  }

  /**
   * Whether the licence this device holds grants the entitlement `code`: a
   * flag that is on, a number that is not zero, or a text that is not empty
   * (`grants`). Offline, from the stored lease only: the entitlements of the
   * status `status()` gives from what is stored, with no ask and no write, so
   * a licence that does not license this build, and none at all, grant
   * nothing. A running trial grants what its trial lease does. Never rejects
   * for storage: a state that cannot be read grants nothing just now.
   */
  async has(code: string): Promise<boolean> {
    return grants((await this.storedStatus()).entitlements, code)
  }

  /**
   * As `has(code)`, but rejecting with `MissingEntitlementError`, which names
   * `code`, when the licence does not grant that entitlement: for work that
   * may run only when it does.
   */
  async require(code: string): Promise<void> {
    if (!(await this.has(code))) throw new MissingEntitlementError(code)
  }

  /**
   * Spend `n` (default 1) uses of the key's meter `meter`, before the work they count; do the work only on
   * `ok`. Online it is exact: the server takes `n` only while the meter has room for all of it
   * (`used-up`, with `left`, otherwise). With no answer (no network, a timeout, a 5xx or 429) it spends from
   * this device's offline allowance for the meter, never past what the device last heard is left
   * (`offline-limit`), and reports the spend with its next check-in. Needs a key's lease that licenses this
   * build here (`not-licensed` otherwise, asking nothing); a trial and an offline licence file have no
   * meters. Never rejects: every outcome is in its answer. Two calls are two spends.
   */
  use(meter: string, n = 1): Promise<UseResult> {
    return this.useMeter(meter, n)
  }

  /** The claims of the key's lease when what is stored licenses this build as `status()` would say (`MeterEngine`). */
  protected async keyClaims(state: StoredState): Promise<LeaseClaims | null> {
    const status = await this.statusNow(state, false, true)
    if (status.state !== 'licensed' || status.source === 'file' || !state.lease) return null
    const check = await this.evaluate(state.lease, this.effectiveNow(state), state)
    return check.ok ? check.claims : null
  }

  /** The status from what is stored only, with no ask and no write, as a read-only `status()` answers it. */
  private async storedStatus(): Promise<LicenseStatus> {
    const state = await this.loadForStatus(true)
    return state ? this.statusNow(state, false, true) : { ...UNREADABLE }
  }

  /**
   * Begin (or re-sync) a trial for this device. As `status()` for storage, as
   * it answers a status and an app may call it at launch: `unknown` when the
   * state cannot be read, and the server's trial when it cannot be saved.
   */
  startTrial(): Promise<LicenseStatus> {
    return this.serial(async (readOnly) => {
      const state = await this.loadForStatus(readOnly)
      if (!state) return readOnly ? { ...UNREADABLE, stalled: true } : { ...UNREADABLE }
      if (!readOnly) return this.startTrialNow(state)
      // From storage behind a call that has not finished, and saying so, as status() does.
      return { ...(await this.trialStatus(state, this.effectiveNow(state))), stalled: true }
    })
  }

  // --- internals -------------------------------------------------------------

  /**
   * The status, asking the server when it should. `readOnly` (behind a call
   * that has not settled, engine.ts `serial`): from what is stored only, with
   * no ask and no write.
   */
  private async statusNow(state: StoredState, forceOnline: boolean, readOnly: boolean): Promise<LicenseStatus> {
    // A stored offline licence file that licenses this build wins, offline, with no ask
    // and no write; one that does not answers only when no key path and no running trial does.
    const file = await this.fileStatus(state)
    if (file?.state === 'licensed') return file
    const now = this.effectiveNow(state)
    // A device refusal stands only for the device it was given for: who this is.
    const device = state.refused === 'device' ? await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind) : undefined
    const refused = state.key ? standingRefusal(state, this.major, device) : null
    if (refused && readOnly) return { state: 'invalid', reason: refused, key: state.key }
    if (refused) return this.refusedStatus(state, refused, forceOnline)
    if (state.key && state.lease) return this.licenseStatus(state, state.lease, now, forceOnline, readOnly)
    return this.trialOrFile(state, now, file, { forceOnline, readOnly })
  }

  /**
   * With no key to answer: a trial this device started while it runs, else a
   * stored file that does not license this build (why is the news), else the
   * trial that has ended, else `unlicensed`.
   */
  private async trialOrFile(
    state: StoredState,
    now: number,
    file: LicenseStatus | null,
    opts: { forceOnline: boolean; readOnly: boolean },
  ): Promise<LicenseStatus> {
    const trial = state.trialStart != null ? await this.trialStatus(state, now, opts) : null
    if (trial?.state === 'trial') return trial
    return file ?? trial ?? { state: 'unlicensed' }
  }

  /**
   * A refusal that stands for this build: answered as stored, and asked again
   * once the wait after the last ask is over, or when forced (`askDue`), so a
   * renewed or reinstated key heals; it stands while the server repeats it or
   * is out of reach.
   */
  private async refusedStatus(state: StoredState, refused: Refusal, force: boolean) {
    const stored: LicenseStatus = { state: 'invalid', reason: refused, key: state.key }
    if (!askDue(state, this.a.clock.now(), force)) return stored
    return (await this.tryRenew(state)) ?? stored
  }

  private async licenseStatus(
    state: StoredState,
    lease: string,
    now: number,
    forceOnline: boolean,
    readOnly: boolean,
  ): Promise<LicenseStatus> {
    // Not this licence (another key or activation: `tampered`), or not this
    // device (`device`): the server is asked under the usual waits, below.
    const evaluated = await this.evaluate(lease, now, state)
    // What the lease says offline, entitlements included: the answer whenever
    // the server gives no verdict (offline.ts `leaseStatus`).
    const offline = evaluated.ok ? meteredStatus(leaseStatus(evaluated, state.key), evaluated.claims, state) : leaseStatus(evaluated, state.key)
    if (!evaluated.ok) {
      // Not licensed here (expired, tampered, unknown-key, upgrade, outdated or device). Give
      // the server a chance to heal it (issue a fresh lease) before locking the
      // user out, once the wait after the last ask is over, or when forced. Only
      // if the server is unreachable (or agrees) is the lease's own answer given.
      const renewed = !readOnly && askDue(state, this.a.clock.now(), forceOnline) ? await this.tryRenew(state) : null
      return renewed ?? offline
    }
    return readOnly ? offline : this.licensedNow(state, evaluated.claims, offline, now, forceOnline)
  }

  /**
   * A lease that licenses this build (`offline`, its status): this run noted
   * (`keptMajor`), then asked online when forced, or, bounded in time, when the
   * server should hear from this device before the lease runs out (a newer
   * major on an open lease, or a lease nearing its end) and the wait allows
   * (renewal.ts `asksOnValidLease`). The valid lease is the answer when the ask
   * gets no verdict.
   */
  private async licensedNow(
    state: StoredState,
    claims: LeaseClaims,
    offline: LicenseStatus,
    now: number,
    forceOnline: boolean,
  ): Promise<LicenseStatus> {
    const held = await this.noteKept(state, claims, now)
    if (forceOnline) return (await this.tryRenew(held)) ?? offline
    // The journal that asks is the one a request would report (engine.ts `reportable`): spends held in memory that no request carries do not make `status()` ask at every call.
    const ask = { claims, state: { ...held, spends: await this.reportable(held) }, major: this.major, now, clockNow: this.a.clock.now() }
    if (!asksOnValidLease(ask)) return offline
    return (await this.tryRenew(held, STATUS_CHECK_TIMEOUT_MS)) ?? offline
  }

  /** The state with this run noted in `keptMajor`, persisted when that changed. */
  private async noteKept(state: StoredState, claims: LeaseClaims, now: number): Promise<StoredState> {
    const keptMajor = keptWith(state.keptMajor, claims, now, this.major)
    if (keptMajor === state.keptMajor) return state
    // About this activation: not saved onto another one stored meanwhile.
    await this.saveBestEffort({ keptMajor }, undefined, { about: { activationId: state.activationId } })
    return { ...state, keptMajor }
  }
}

/** What `status()` answers when the stored state cannot be read just now. */
const UNREADABLE: LicenseStatus = { state: 'unknown', reason: 'storage' }
