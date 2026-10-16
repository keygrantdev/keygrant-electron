/**
 * The online validate under `License` (license.ts): the request a renewal makes, the lease its answer
 * carries judged on this device, what the answer does to the stored state (renewal.ts `renewalOutcome`), and
 * the journal of unsynced spends it reports and the confirmations it brings back (the SDK contract, 12.2).
 * `License` decides when to go online and what to answer.
 */
import type { Asked, LeaseCheck } from './offline.js'
import type { DeviceKind, LicenseStatus, StoredState } from './types.js'
import type { Device } from './device.js'
import { Engine } from './engine.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { landJournal, type JournalOp } from './journal.js'
import { meteredStatus, spendsConfirmed, spendsReported } from './meters.js'
import { renewalOutcome, type ValidateResponse } from './renewal.js'
import { guardedNow } from './clock.js'
import { ASK_AGAIN_MS } from './offline.js'
import { noAnswer, parseLeaseBody, type Renewal } from './wire.js'

export abstract class CheckinEngine extends Engine {
  /** Attempt an online validate; returns a status on a definitive answer, else null. */
  protected async tryRenew(state: StoredState, timeoutMs?: number): Promise<LicenseStatus | null> {
    const renewal = await this.renew(state, timeoutMs)
    return renewal.answered ? renewal.status : null
  }

  /**
   * An online validate, and whether the server gave a verdict. What its answer
   * saves and says is renewal.ts `renewalOutcome`: any verdict (a lease, a
   * refusal, a body it could not use) records the major it was sent as heard
   * (`checkedMajor`), so the check of a newer major is not made again for it;
   * an ask that came back without a lease starts the wait before the SDK asks
   * again on its own (`askDue`): RETRY_UNANSWERED_MS when nothing answered at
   * all (no network, a timeout), ASK_AGAIN_MS when the server did (a refusal, a
   * 5xx, a 429, an answer it could not use).
   *
   * The request carries the journal of this device's unsynced spends (`spends`), and the entries the
   * answer names as recorded are dropped from it with the rest of what the answer saves; a save that
   * fails keeps that in memory (`saveOps`), and the entries are reported again, which the server counts
   * once. An answer that confirms none of what the request reported (the server could not record it)
   * starts the wait of an answer without a lease, so a journal the server will not take is not offered at
   * every `status()`. A licensed answer's status shows the key's meters (meters.ts `meteredStatus`).
   */
  protected async renew(state: StoredState, timeoutMs?: number): Promise<Renewal> {
    // The wait runs on the device clock, as `askDue` reads it; the answer is
    // stamped by the guarded one, which a clock put back does not move back,
    // so an answer asked for later still reads as later to another process.
    const askedAt = this.a.clock.now()
    const asked: Asked = { at: this.effectiveNow(state), activationId: state.activationId, seen: state.verdictAt }
    // A machine id read here keys this install from now on (`deviceKind`):
    // written with whatever this ask writes, as the seat is re-keyed by it.
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
    // Outside the request's try: a key set that cannot be imported is the app's
    // configuration, never an unanswered check-in.
    const kids = await this.keyIds()
    const reports = spendsReported(await this.reportable(state))
    let response: ValidateResponse | null
    try {
      response = await this.post('validate', { ...this.validateBody(state, device), ...(reports ? { spends: reports } : {}), kids }, timeoutMs)
    } catch {
      response = null
    }
    const judged = await this.judgeFresh(state, response)
    const { keptMajor, key } = state
    const outcome = renewalOutcome({ response, ...judged, askedAt, major: this.major, key, keptMajor, device })
    const ops = confirmations(state, response)
    const heard = response !== null && !noAnswer(response.status)
    const patch = reports && heard && ops.length === 0 ? { ...outcome.patch, backoffSince: askedAt, backoffMs: ASK_AGAIN_MS } : outcome.patch
    // Saved as the answer to its ask; a save that fails leaves the answer standing (`saveOps`).
    await this.saveOps(state, patch, { answer: asked }, ops)
    return outcome.answered ? { answered: true, status: this.metered(outcome.status, judged.check, state, ops) } : { answered: false }
  }

  /** A licensed answer's status with the meters of the lease that brought it, net of the journal as the answer left it. */
  private metered(status: LicenseStatus | null, check: LeaseCheck | undefined, state: StoredState, ops: readonly JournalOp[]): LicenseStatus | null {
    if (status === null || check === undefined || !check.ok) return status
    return meteredStatus(status, check.claims, landJournal(state, ops, guardedNow(this.a.clock.now(), state.lastSeen)).state)
  }

  /**
   * The lease a validate's 200 carried, checked on this device (`evaluate`) as
   * of the server's time (`serverNow`, the clock guard brought back best-effort:
   * the server's time even when the state cannot be read or saved just now);
   * no check for any other answer. With the time it was judged at.
   */
  private async judgeFresh(
    state: StoredState,
    response: ValidateResponse | null,
  ): Promise<{ check?: LeaseCheck; now: number }> {
    const lease = response?.status === 200 ? parseLeaseBody(response.json).lease : undefined
    if (!lease) return { now: this.effectiveNow(state) }
    const holder = { key: state.key ?? '', activationId: state.activationId ?? '', deviceKind: state.deviceKind }
    return this.judged(lease, holder, this.effectiveNow(state))
  }

  /**
   * A lease the server just answered, checked for `holder` on this device
   * (`evaluate`) as of the server's time (`serverNow`, the clock guard brought
   * back best-effort; `fallbackNow` when the state cannot be read or saved
   * just now). With the time it was judged at.
   */
  protected async judged(
    lease: string,
    holder: { key: string; activationId: string; deviceKind?: DeviceKind },
    fallbackNow: number,
  ): Promise<{ check: LeaseCheck; now: number }> {
    const saveGuard = async (patch: Partial<StoredState>, guard?: number) => {
      await this.saveBestEffort(patch, guard)
    }
    const mine = { key: holder.key, activationId: holder.activationId }
    const now = await this.serverNow(lease, mine, saveGuard).catch(() => fallbackNow)
    return { check: await this.evaluate(lease, now, holder), now }
  }

  /**
   * What a validate and a `use` both send for the server's device check. With every fingerprint this
   * device answers to, when it can tell, so the server refuses a state file copied from another machine
   * (`device`) before it touches the seat; with none when it cannot tell this time, so a slow read never
   * costs an honest device its renewal.
   */
  protected deviceBody(state: StoredState, device: Device) {
    return {
      key: state.key,
      activationId: state.activationId,
      major: this.major,
      ...(device.canTell ? { fingerprints: device.fingerprints } : {}),
      ...(device.canTell && device.kind ? { fingerprintKind: device.kind } : {}),
    }
  }

  /** A validate's body: the device check, and the kept major. */
  private validateBody(state: StoredState, device: Device) {
    return { ...this.deviceBody(state, device), ...(state.keptMajor !== undefined ? { keptMajor: state.keptMajor } : {}) }
  }
}

/** The journal change an answer's confirmations make, about the activation it was asked for: none when it named none. */
function confirmations(state: StoredState, response: ValidateResponse | null): JournalOp[] {
  const entries = spendsConfirmed(response)
  return entries.length > 0 && state.activationId !== undefined ? [{ kind: 'confirmed', about: state.activationId, entries }] : []
}
