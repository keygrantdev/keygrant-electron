/**
 * Buying from the app with no key typed, under `License` (license.ts): the
 * purchase link (`purchaseUrlNow`, which keeps this install's one-time secret
 * and hands out the reference to it) and the pickup (`pickUp`): while no key
 * is held and a secret is, asking the server for the key bought with it
 * (`claim`) and saving it exactly as `activate(key)` saves one. What each
 * answer does is pickup.ts; `License` decides when to ask.
 */
import type { LicenseConfig, LicenseStatus, StoredState } from './types.js'
import { TrialEngine } from './trials.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import type { Device } from './device.js'
import { NO_PURCHASE, merged, type Basis, type LeaseCheck } from './offline.js'
import {
  claimDue,
  claimOutcome,
  claimRequest,
  newPurchaseSecret,
  purchaseLink,
  purchaseTokenKept,
  type ClaimRequest,
  type ClaimResponse,
} from './pickup.js'
import { MAX_DEVICE_NAME, STATUS_CHECK_TIMEOUT_MS, parseClaimBody, trimToLength } from './wire.js'

/**
 * How a pickup asks: for `startTrial()` (`start`: always, under the device
 * `startTrial()` read for both its asks, `device`, bounded as a status check
 * is, a host-name fallback allowed), or for `status()` (when `force`d, under
 * the HTTP bound, or when `claimDue`, bounded as a status check is), reading
 * the device as a status does and asking only under its own fingerprint.
 */
export interface PickupAsk {
  start: boolean
  force: boolean
  device?: Device
}

/** What a pickup did: the licensed status when a bought key licensed this device, else the state to answer from. */
export type Pickup = { status: LicenseStatus } | { state: StoredState }

export abstract class PurchaseEngine extends TrialEngine {
  /** The device name an activation and a claim report, cut to what the server takes. */
  protected readonly deviceName?: string

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

  /**
   * `purchaseUrl`'s answer (license.ts): null while a key is held; else the
   * link carrying the reference to the held secret, or to a new one, saved
   * with when its link was handed out (the claim's wait cleared, so the next
   * `status()` asks). Read-only (behind a call that has not settled), a held
   * secret's link is answered as it is and none held rejects: a secret that
   * is not saved could never be picked up.
   */
  protected async purchaseUrlNow(link: string, readOnly: boolean): Promise<string | null> {
    const state = await this.load(readOnly)
    if (state.key) return null
    const now = this.effectiveNow(state)
    const held = purchaseTokenKept(state, now) ? state.purchaseToken : undefined
    if (readOnly) {
      if (held === undefined) throw new Error('a previous licence call has not finished; try again')
      return purchaseLink(link, held)
    }
    const secret = held ?? newPurchaseSecret()
    await this.save({ purchaseToken: secret, purchaseTokenAt: now, claimAskedAt: undefined })
    return purchaseLink(link, secret)
  }

  /**
   * The key bought through `purchaseUrl`, picked up: with no key held and a
   * secret held, the secret is dropped once past its bound
   * (`purchaseTokenKept`), and otherwise the claim is asked as `ask` says.
   * Never asked behind a call that has not settled: the caller skips it.
   */
  protected async pickUp(state: StoredState, ask: PickupAsk): Promise<Pickup> {
    const secret = state.purchaseToken
    if (state.key || secret === undefined) return { state }
    const now = this.effectiveNow(state)
    if (!purchaseTokenKept(state, now)) return { state: await this.dropSecret(state, secret) }
    if (!ask.start && !ask.force && !claimDue(state, this.a.clock.now(), now)) return { state }
    return this.claim(state, secret, ask)
  }

  /** The secret dropped (saved about it, best-effort): the state without it. */
  private async dropSecret(state: StoredState, secret: string): Promise<StoredState> {
    const basis: Basis = { purchase: { token: secret } }
    await this.saveBestEffort(NO_PURCHASE, undefined, basis)
    return merged(state, NO_PURCHASE, basis)
  }

  /**
   * Ask for the key bought with `secret` (`claim`) and save what the answer
   * does (pickup.ts `claimOutcome`): a bought key as an activation, a wait or
   * a drop about the secret. The body is pickup.ts `claimRequest`'s: from
   * `status()`, a device whose own fingerprint did not read is not asked at
   * all, and nothing is saved, so the next status asks again; at
   * `startTrial()`, a device with no fingerprint at all is no answer. Saved
   * best-effort: a bought key the
   * disk refused is answered all the same, and the next claim answers it again
   * (the server knows this device by any of the fingerprints it sends).
   */
  private async claim(state: StoredState, secret: string, ask: PickupAsk): Promise<Pickup> {
    const clockNow = this.a.clock.now()
    const askedAt = this.effectiveNow(state)
    const device = ask.device ?? (await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind))
    const body = claimRequest({ secret, device, name: this.deviceName, major: this.major, start: ask.start })
    if (body === null && !ask.start) return { state }
    const timeoutMs = ask.force && !ask.start ? undefined : STATUS_CHECK_TIMEOUT_MS
    const response = body === null ? null : await this.postClaim(body, timeoutMs)
    const judged = await this.judgeClaim(response, body?.fingerprintKind, askedAt)
    const kind = body?.fingerprintKind ? { kind: body.fingerprintKind } : {}
    const outcome = claimOutcome({ response, ...judged, clockNow, major: this.major, ...kind })
    if (outcome.result === 'bought') {
      const activation = { at: askedAt, activationId: outcome.patch.activationId, seen: state.verdictAt }
      await this.saveBestEffort(outcome.patch, undefined, { activation })
      return { status: outcome.status }
    }
    // A wait is about the secret as its link was handed out when asked; a drop about the secret alone (merge.ts).
    const about = outcome.result === 'kept' ? { token: secret, at: state.purchaseTokenAt } : { token: secret }
    const basis: Basis = { purchase: about }
    await this.saveBestEffort(outcome.patch, undefined, basis)
    return { state: merged(state, outcome.patch, basis) }
  }

  /** POST `claim` with its body (pickup.ts `claimRequest`); null when it threw or timed out. */
  private async postClaim(body: ClaimRequest, timeoutMs: number | undefined): Promise<ClaimResponse | null> {
    const kids = await this.keyIds()
    try {
      return await this.post('claim', { ...body, kids }, timeoutMs)
    } catch {
      return null
    }
  }

  /**
   * The lease a claim's 200 carried with a key and an activation id, checked
   * for them on this device as of the server's time (engine.ts `judged`); no
   * check for any other answer. With the time it was judged at.
   */
  private async judgeClaim(
    response: ClaimResponse | null,
    kind: ClaimRequest['fingerprintKind'],
    askedAt: number,
  ): Promise<{ check?: LeaseCheck; now: number }> {
    const body = response?.status === 200 ? parseClaimBody(response.json) : {}
    const { key, activationId, lease } = body
    if (key === undefined || activationId === undefined || lease === undefined) return { now: askedAt }
    return this.judged(lease, { key, activationId, deviceKind: kind }, askedAt)
  }
}
