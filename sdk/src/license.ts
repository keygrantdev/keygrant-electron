import type { LeaseClaims } from '@keygrant/shared'
import type { ActivateResult, DeactivateResult, LicenseConfig, LicenseStatus, Refusal, StoredState } from './types.js'
import { TrialEngine } from './trials.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { activationIdentity } from './device.js'
import { UNKEYED, activationPatch, sameKey, askDue, heldElsewhere, keptWith, leaseStatus, standingRefusal } from './offline.js'
import { referencedLink } from './link.js'
import { asksOnValidLease } from './renewal.js'
import { MAX_DEVICE_NAME, STATUS_CHECK_TIMEOUT_MS, enteredKey, errorOf, mapServerError, parseLeaseBody, trimToLength } from './wire.js'
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
 *    heard, on an open lease, or when the lease is nearing its end
 *    (`renewsEarly`); bounded by STATUS_CHECK_TIMEOUT_MS, and the valid lease
 *    is the answer when that gets no verdict;
 *  - a lease past its end or otherwise invalid here, and a stored refusal that
 *    stands for this build: to give the server the chance to heal it;
 *  - a trial whose lease does not verify here while its stored end is still
 *    ahead (a lease signed before the product's key was rotated, say): the
 *    trial is asked for again, bounded by STATUS_CHECK_TIMEOUT_MS (`healTrial`);
 *  - a running trial: its launch reported, at most once a day, in the
 *    background and never awaited (trials.ts `reportLaunch`).
 */
export class License extends TrialEngine {
  /** The device name an activation reports, cut to what the server takes. */
  private readonly deviceName?: string

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

  /** Activate a license key on this device. */
  activate(key: string): Promise<ActivateResult> {
    // Behind a call that has not settled (engine.ts `serial`), nothing may be
    // written: the activation is answered as not reaching the server, to retry.
    return this.serial(async (readOnly) => (readOnly ? { ok: false, error: 'network' } : this.activateNow(key)))
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
      if (!readOnly) await this.saveUnsavedTrial()
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

  private async activateNow(key: string): Promise<ActivateResult> {
    // Normalised, and refused here when it cannot be a key (wire.ts `enteredKey`).
    const entered = enteredKey(key)
    if (entered === null) return { ok: false, error: 'invalid-key' }
    // Install memory protects the seat this install holds: re-activating that
    // key keeps to it; a first activation, or another key's, starts afresh.
    const stored = await this.load()
    const sameSeat = stored.key !== undefined && sameKey(stored.key, entered)
    const installKind = sameSeat ? this.installKind(stored.deviceKind) : undefined
    const identity = activationIdentity(await this.device(ACTIVATE_MACHINE_ID_TIMEOUT_MS, installKind), installKind)
    if (identity === null) return { ok: false, error: 'network' }
    const { fingerprint, kind } = identity
    let res: { status: number; json: unknown }
    // The answer is stamped with when it was asked for (`verdictAt`, guarded
    // clock): an older ask's answer, from another process, is not saved over it.
    const askedAt = this.effectiveNow(stored)
    // Outside the request's try: a key set that cannot be imported is the app's
    // configuration, never a network failure.
    const kids = await this.keyIds()
    try {
      const body = { key: entered, fingerprint, ...(kind ? { fingerprintKind: kind } : {}), name: this.deviceName, major: this.major, kids }
      res = await this.post('activate', body)
    } catch {
      return { ok: false, error: 'network' }
    }
    if (res.status !== 200) return { ok: false, error: mapServerError(errorOf(res.json)) }

    const { lease, activationId } = parseLeaseBody(res.json)
    if (!lease || !activationId) return { ok: false, error: 'network' }
    const now = await this.serverNow(lease, { key: entered, activationId })
    const evaluated = await this.evaluate(lease, now, { key: entered, activationId, deviceKind: kind })
    if (!evaluated.ok) return { ok: false, error: 'invalid-lease' }

    const patch = activationPatch({ key: entered, activationId, lease, claims: evaluated.claims, now, major: this.major, kind })
    await this.save(patch, undefined, { activation: { at: askedAt, activationId, seen: stored.verdictAt } })
    return { ok: true }
  }

  private async deactivateNow(): Promise<DeactivateResult> {
    const state = await this.load()
    // Nothing held is nothing to release: the seat is as free as it gets. Nor
    // is a seat another device holds this one's to release (`seatElsewhere`).
    let released = true
    if (state.key && state.activationId && !(await this.seatElsewhere(state))) {
      try {
        // Only a 200 is KeyGrant saying the seat is free. A 5xx, a 429 or a
        // proxy's page is an answer, but not that one.
        const res = await this.post('deactivate', { key: state.key, activationId: state.activationId })
        released = res.status === 200
      } catch {
        /* best-effort; still clear locally */
        released = false
      }
    }
    // Stamped (`verdictAt`) so that an answer to an older ask is not saved over it.
    await this.save({ ...UNKEYED, verdictAt: this.effectiveNow(state) })
    return { released }
  }

  /**
   * Whether the stored activation is another device's: a device refusal that
   * stands for this one, or a lease held to a machine id this device does not
   * have, expired or not (`heldElsewhere`). A state file copied or restored from
   * another PC carries that PC's activation; releasing it would lock that PC out
   * at its next check-in, so `deactivate()` only drops it here, and this device,
   * which holds no seat, answers `released`.
   */
  private async seatElsewhere(state: StoredState): Promise<boolean> {
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
    if (standingRefusal(state, this.major, device) === 'device') return true
    return state.lease ? heldElsewhere(await this.verify(state.lease, this.effectiveNow(state)), device) : false
  }

  /**
   * The status, asking the server when it should. `readOnly` (behind a call
   * that has not settled, engine.ts `serial`): from what is stored only, with
   * no ask and no write.
   */
  private async statusNow(state: StoredState, forceOnline: boolean, readOnly: boolean): Promise<LicenseStatus> {
    const now = this.effectiveNow(state)
    // A device refusal stands only for the device it was given for: who this is.
    const device = state.refused === 'device' ? await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind) : undefined
    const refused = state.key ? standingRefusal(state, this.major, device) : null
    if (refused && readOnly) return { state: 'invalid', reason: refused, key: state.key }
    if (refused) return this.refusedStatus(state, refused, forceOnline)
    if (state.key && state.lease) return this.licenseStatus(state, state.lease, now, forceOnline, readOnly)
    if (state.trialStart != null) return this.trialStatus(state, now, { forceOnline, readOnly })
    return { state: 'unlicensed' }
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
    const offline = leaseStatus(evaluated, state.key)
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
    const ask = { claims, state: held, major: this.major, now, clockNow: this.a.clock.now() }
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
