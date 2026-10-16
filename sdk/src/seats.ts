/**
 * The seat machinery under `License` (license.ts): taking a seat on a key (`activateNow`) and releasing it
 * (`deactivateNow`). The journal of unsynced spends (journal.ts) belongs to the seat: activating another seat
 * drops it unreported, and a release reports it with the request and clears it with the rest.
 */
import type { ActivateOptions, ActivateResult, DeactivateResult, StoredState } from './types.js'
import type { Device } from './device.js'
import { MeterEngine } from './spend.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { activationIdentity } from './device.js'
import { UNKEYED, activationPatch, heldElsewhere, sameKey, standingRefusal } from './offline.js'
import { spendsReported } from './meters.js'
import { enteredKey, errorOf, mapServerError, parseLeaseBody, typedFor } from './wire.js'

export abstract class SeatEngine extends MeterEngine {
  /** The device name an activation reports, cut to what the server takes (license.ts). */
  protected abstract readonly deviceName: string | undefined

  protected async activateNow(key: string, options: ActivateOptions): Promise<ActivateResult> {
    // Normalised, and refused here when it cannot be a key (wire.ts `enteredKey`).
    const entered = enteredKey(key)
    if (entered === null) return { ok: false, error: 'invalid-key' }
    // What a person typed for a user-locked key: one that can be no address, or no code, is
    // refused here, before anything is asked of the server or its wrong tries are spent.
    const typed = typedFor(options)
    if ('refused' in typed) return { ok: false, error: typed.refused }
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
      const body = { key: entered, fingerprint, ...(kind ? { fingerprintKind: kind } : {}), name: this.deviceName, major: this.major, kids, ...typed.send }
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
    // Activating another seat drops the journal of the old one, unreported; the same seat keeps it.
    await this.saveWith(patch, undefined, { activation: { at: askedAt, activationId, seen: stored.verdictAt } }, [{ kind: 'activated', about: activationId }])
    return { ok: true }
  }

  protected async deactivateNow(): Promise<DeactivateResult> {
    // What this process could not save lands first, so the release reports it: the journal goes with the seat.
    await this.saveUnsavedJournal()
    const state = await this.load()
    // Nothing held is nothing to release: the seat is as free as it gets. Nor
    // is a seat another device holds this one's to release (`seatElsewhere`).
    let released = true
    if (state.key && state.activationId) {
      const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
      if (!(await this.seatElsewhere(state, device))) released = await this.release(state, device)
    }
    // Stamped (`verdictAt`) so that an answer to an older ask is not saved over it. The journal goes
    // with the rest of the licence: what the release carried is all the server will hear of it.
    await this.saveWith({ ...UNKEYED, verdictAt: this.effectiveNow(state) }, undefined, undefined, [{ kind: 'deactivated' }])
    return { released }
  }

  /**
   * The release request, carrying the journal of unsynced spends and, with it, the device's fingerprints as a
   * validate sends them (so the server holds the reports to the seat's device; none when it cannot tell).
   * Only a 200 is KeyGrant saying the seat is free: a 5xx, a 429 or a proxy's page is an answer, but not that one.
   */
  private async release(state: StoredState, device: Device): Promise<boolean> {
    const reports = spendsReported(await this.reportable(state))
    const reported = reports ? { spends: reports, ...(device.canTell ? { fingerprints: device.fingerprints } : {}) } : {}
    try {
      const res = await this.post('deactivate', { key: state.key, activationId: state.activationId, ...reported })
      return res.status === 200
    } catch {
      /* best-effort; still clear locally */
      return false
    }
  }

  /**
   * Whether the stored activation is another device's: a device refusal that
   * stands for this one, or a lease held to a machine id this device does not
   * have, expired or not (`heldElsewhere`). A state file copied or restored from
   * another PC carries that PC's activation; releasing it would lock that PC out
   * at its next check-in, so `deactivate()` only drops it here, and this device,
   * which holds no seat, answers `released`.
   */
  private async seatElsewhere(state: StoredState, device: Device): Promise<boolean> {
    if (standingRefusal(state, this.major, device) === 'device') return true
    return state.lease ? heldElsewhere(await this.verify(state.lease, this.effectiveNow(state)), device) : false
  }
}
