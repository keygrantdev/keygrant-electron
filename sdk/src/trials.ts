/**
 * The trial machinery under `License` (license.ts): asking the server for this
 * device's trial and saving its answer (`askTrial`), even when the disk refuses
 * it for now (`unsavedTrial`); a trial's status from what the device holds
 * (`trialStatus`); asking again for a trial whose lease does not verify
 * while its stored end is still ahead (`healTrial`); and a running trial's
 * launch, reported at most once a day in the background (`reportLaunch`).
 * `License` decides when.
 */
import type { StoredState, LicenseStatus } from './types.js'
import { Engine } from './engine.js'
import type { Device } from './device.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import {
  ASK_AGAIN_MS,
  RETRY_UNANSWERED_MS,
  TRIAL_REPORT_MS,
  askDue,
  merged,
  trialStatusOf,
  type Basis,
  type Stamp,
  type TrialLease,
} from './offline.js'
import { STATUS_CHECK_TIMEOUT_MS, earliest, parseTrialBody } from './wire.js'

/** A trial answer's body, as `parseTrialBody` takes it. */
type TrialBody = NonNullable<ReturnType<typeof parseTrialBody>>

/**
 * Whether a running trial reports its launch at `now` (the guarded clock):
 * neither its last trial answer (`trialAt`, a `startTrial()` or a heal) nor
 * its last report (`trialReportedAt`) is within TRIAL_REPORT_MS before `now`.
 * A stamp that is absent, or at least that long before `now`, is not within
 * it; one ahead of `now` is.
 */
export function trialReportDue(state: StoredState, now: number): boolean {
  const recent = (at: number | undefined) => at !== undefined && now - at < TRIAL_REPORT_MS
  return !recent(state.trialAt) && !recent(state.trialReportedAt)
}

/** The launch report each engine has in flight (`reportLaunch`), which the SDK itself never awaits. */
const reports = new WeakMap<TrialEngine, Promise<void>>()

/**
 * Settles once the launch report `engine` has in flight, if any, has settled.
 * Test support: not exported from the package.
 */
export function launchReportSettled(engine: TrialEngine): Promise<void> {
  return reports.get(engine) ?? Promise.resolve()
}

export abstract class TrialEngine extends Engine {
  /**
   * The server's trial when it could not be saved (`startTrial`), kept for this
   * process: merged into every state a status reads, and saved by the next
   * call that can (`saveUnsavedTrial`), so the trial is not lost to the next
   * `status()` while the disk refuses it.
   */
  protected unsavedTrial?: { patch: Partial<StoredState>; basis: Basis }

  /**
   * The stored state for a status, with a trial this process could not save
   * (`unsavedTrial`); or null when it cannot be read just now (`UNREADABLE`).
   */
  protected async loadForStatus(readOnly: boolean): Promise<StoredState | null> {
    const state = await this.load(readOnly).catch(() => null)
    const unsaved = this.unsavedTrial
    if (!state || !unsaved) return state
    // As a save would merge it: a newer trial answer stored since wins.
    return merged(state, unsaved.patch, unsaved.basis)
  }

  /** Save the trial this process could not (`unsavedTrial`), and forget it once saved. Best-effort. */
  protected async saveUnsavedTrial(): Promise<void> {
    const unsaved = this.unsavedTrial
    if (unsaved && (await this.saveBestEffort(unsaved.patch, undefined, unsaved.basis))) this.unsavedTrial = undefined
  }

  /** `startTrial()`'s trial ask, under the device `startTrial()` read (`known`), else read now. */
  protected async startTrialNow(state: StoredState, known?: Device): Promise<LicenseStatus> {
    const { latest } = await this.askTrial(state, ACTIVATE_MACHINE_ID_TIMEOUT_MS, undefined, known)
    // The server's trial even when it could not be saved: kept for this
    // process (`unsavedTrial`) until a later call saves it.
    return this.trialStatus(latest, this.effectiveNow(state))
  }

  /**
   * Ask the server for this device's trial (`trial`, with the earliest start
   * the device holds as `clientStart`) and save its answer: `reached` when the
   * server answered at all, `latest` the state with its trial merged in.
   */
  private async askTrial(
    state: StoredState,
    machineIdTimeoutMs: number,
    timeoutMs?: number,
    known?: Device,
  ): Promise<{ reached: boolean; latest: StoredState }> {
    const device = known ?? (await this.device(machineIdTimeoutMs, state.deviceKind))
    // The stash is the app's own adapter (the Windows registry, say), and it can
    // cost nothing: one that cannot be read is no evidence, and `startTrial()`
    // still answers rather than reject.
    const regStart = await settle(() => this.a.registry.readTrialStart(), null)
    const clientStart = earliest(state.trialStart, regStart ?? undefined)
    // A device that cannot be told this time starts no trial: as offline.
    if (device.own === null) return { reached: false, latest: state }
    const kind = device.kind ? { fingerprintKind: device.kind } : {}
    // The answer is stamped with when it was asked for (`trialAt`, guarded
    // clock): an older one, from another process, is not saved over it.
    const asked = { at: this.effectiveNow(state), seen: state.trialAt }
    let res: { status: number; json: unknown }
    try {
      res = await this.post('trial', { fingerprint: device.own, ...kind, clientStart }, timeoutMs)
    } catch {
      // Offline: whatever local trial evidence the device holds stands.
      return { reached: false, latest: state }
    }
    const body = res.status === 200 ? parseTrialBody(res.json) : null
    return { reached: true, latest: body ? await this.takeTrial(state, body, regStart, asked) : state }
  }

  /**
   * The server's trial, saved as the answer to its ask (`asked`), or kept for
   * this process when the disk refuses it (`unsavedTrial`): the state with it
   * merged in.
   */
  private async takeTrial(state: StoredState, body: TrialBody, regStart: number | null, asked: Stamp): Promise<StoredState> {
    // Take the earliest start across all evidence: never move it forward.
    const trialStart = earliest(body.trialStart, state.trialStart, regStart ?? undefined) ?? body.trialStart
    // Mirrored to the stash before the save; a stash that cannot be written
    // does not throw the server's trial away with it.
    await settle(() => this.a.registry.writeTrialStart(trialStart), undefined)
    // A trial lease this build cannot verify (signed with a key the product
    // rotated to ahead of this build, say) never replaces one it can: a trial
    // runs only on a valid lease (`trialStatusOf`), so taking it would end a
    // running trial. As a renewal keeps the lease it has when the answer's
    // will not verify (renewal.ts).
    const trialLease = (await this.keepsItsTrialLease(state, body.lease)) ? state.trialLease : body.lease
    const trial = { trialStart, trialEndsAt: body.trialEndsAt, trialLease }
    const basis: Basis = { trial: asked }
    this.unsavedTrial = (await this.saveBestEffort(trial, undefined, basis)) ? undefined : { patch: trial, basis }
    return merged(state, trial, basis)
  }

  /** Whether a trial answer's lease fails here while the stored one verifies (`askTrial`). */
  private async keepsItsTrialLease(state: StoredState, answered: string | undefined): Promise<boolean> {
    if (answered === undefined || state.trialLease === undefined) return false
    const now = this.effectiveNow(state)
    if ((await this.trialLease(answered, now, state.deviceKind)).valid) return false
    return (await this.trialLease(state.trialLease, now, state.deviceKind)).valid
  }

  /**
   * A trial's status from what the device holds. With `ask` (a `status()`), a
   * trial whose lease does not verify while its stored end is still ahead is
   * asked for again first (`healTrial`), and a running one reports its launch
   * when due (`reportLaunch`); neither read-only.
   */
  protected async trialStatus(
    state: StoredState,
    now: number,
    ask?: { forceOnline: boolean; readOnly: boolean },
  ): Promise<LicenseStatus> {
    const lease: TrialLease = state.trialLease ? await this.trialLease(state.trialLease, now, state.deviceKind) : { valid: false }
    const status = trialStatusOf(state, now, lease.valid, lease.endsAt, lease.entitlements)
    if (!ask || ask.readOnly) return status
    if (status.state === 'trial') {
      await this.reportLaunch(state, now)
      return status
    }
    const storedEndAhead = state.trialEndsAt != null && now < state.trialEndsAt
    if (lease.valid || !storedEndAhead) return status
    return (await this.healTrial(state, ask.forceOnline)) ?? status
  }

  /**
   * A running trial's launch, reported so the server sees the trial come back
   * (its funnel counts a trial seen a day after it started): with no key held,
   * at most once a day (`trialReportDue`). The stamp (`trialReportedAt`) is
   * saved first, and nothing is sent when it cannot be, so "once a day" holds;
   * then `trial` is POSTed IN THE BACKGROUND, never awaited, so a launch never
   * waits on it and never fails for it offline (`sendLaunch`). Its answer is
   * not read: a change to the trial reaches the device at `startTrial()`.
   */
  private async reportLaunch(state: StoredState, now: number): Promise<void> {
    if (state.key || !trialReportDue(state, now)) return
    if (!(await this.saveBestEffort({ trialReportedAt: now }))) return
    reports.set(this, this.sendLaunch(state).catch(() => undefined))
  }

  /**
   * The report itself: the device read for a status's time, then `trial` with
   * the body `startTrial()` sends (the stored start as `clientStart`, no stash
   * read), bounded as a status check is. A device that cannot be told sends nothing.
   */
  private async sendLaunch(state: StoredState): Promise<void> {
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
    if (device.own === null) return
    const kind = device.kind ? { fingerprintKind: device.kind } : {}
    await this.post('trial', { fingerprint: device.own, ...kind, clientStart: state.trialStart }, STATUS_CHECK_TIMEOUT_MS)
  }

  /**
   * A trial whose lease does not verify here while its stored end is still
   * ahead: a lease signed with the product's key before it was rotated (on a
   * build that ships the new one), one signed to end short of the trial's end,
   * or one never saved whole. The stored end is unsigned, so it runs no trial
   * on its own (`trialStatusOf`): the server is asked for the trial again
   * instead, under the usual waits (`askDue`) and bounded as a status check is,
   * and its answer stands. An ask that brings back no trial this build can
   * verify starts the wait (RETRY_UNANSWERED_MS when nothing answered,
   * ASK_AGAIN_MS when the server did), so a device that is offline, or that
   * carries a key the product no longer signs with, is not asked on every
   * `status()`. Null when it did not ask, or nothing answered.
   */
  private async healTrial(state: StoredState, forceOnline: boolean): Promise<LicenseStatus | null> {
    const askedAt = this.a.clock.now()
    if (!askDue(state, askedAt, forceOnline)) return null
    const { reached, latest } = await this.askTrial(state, MACHINE_ID_TIMEOUT_MS, STATUS_CHECK_TIMEOUT_MS)
    const after = reached ? await this.trialStatus(latest, this.effectiveNow(latest)) : null
    if (after?.state === 'trial') return after
    await this.saveBestEffort({ backoffSince: askedAt, backoffMs: reached ? ASK_AGAIN_MS : RETRY_UNANSWERED_MS })
    return after
  }
}

/** `work`'s answer, or `fallback` when it throws or rejects. */
async function settle<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch {
    return fallback
  }
}
