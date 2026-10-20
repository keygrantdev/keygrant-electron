/**
 * Key pickup under `License` (license.ts; sdk-contract.md section 13): a code
 * mailed to the address a key was sold to (`requestPickup`), that address's
 * keys of the product for the code (`confirmPickup`), and a restore that
 * confirms and activates the key that fits this build (`restoreNow`), so an App
 * Store build licenses itself with no key typed.
 */
import type { PickedKey, PickUpKeysResult, PickUpSentResult, RestoreResult, StoredState } from './types.js'
import { SeatEngine } from './seats.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { PICKUP_KEYS_KEEP_MS, chosenKey, pickedKeysOf, pickupAsk, pickupRefusal } from './pickup.js'

export abstract class PickupEngine extends SeatEngine {
  /** The keys the last confirm answered, by the address and code as sent, in memory only (`PICKUP_KEYS_KEEP_MS`). */
  private confirmed: { email: string; code: string; keys: PickedKey[]; at: number } | null = null

  /** Ask KeyGrant to mail a code to `email`. Writes nothing; never rejects. */
  protected async requestPickup(email: string): Promise<PickUpSentResult> {
    const ask = pickupAsk(email, null)
    if ('refused' in ask) return { ok: false, error: ask.refused }
    let res: { status: number; json: unknown }
    try {
      res = await this.post('pickup', ask.send)
    } catch {
      return { ok: false, error: 'network' }
    }
    return res.status === 200 ? { ok: true, sent: true } : { ok: false, ...pickupRefusal(res.json) }
  }

  /**
   * The address's keys for the code, each marked `held` when this device holds
   * a seat on it (the fingerprints a validate sends, when it can tell who it is).
   * Writes nothing; never rejects.
   */
  protected async confirmPickup(email: string, code: string): Promise<PickUpKeysResult> {
    const ask = pickupAsk(email, code)
    if ('refused' in ask) return { ok: false, error: ask.refused }
    const kept = this.keptKeys(ask.send.email, ask.send.code ?? '')
    if (kept) return { ok: true, keys: kept }
    // Read-only: this runs outside the one-at-a-time order, beside any call.
    const stored: StoredState = await this.load(true).catch(() => ({}))
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, this.installKind(stored.deviceKind))
    let res: { status: number; json: unknown }
    try {
      res = await this.post('pickup/confirm', { ...ask.send, ...(device.canTell ? { fingerprints: device.fingerprints } : {}) })
    } catch {
      return { ok: false, error: 'network' }
    }
    if (res.status !== 200) return { ok: false, ...pickupRefusal(res.json) }
    const keys = pickedKeysOf(res.json)
    if (!keys) return { ok: false, error: 'network' }
    this.confirmed = { email: ask.send.email, code: ask.send.code ?? '', keys, at: this.a.clock.now() }
    return { ok: true, keys }
  }

  /** The keys a confirm with this address and code answered, while they are kept; null otherwise. */
  private keptKeys(email: string, code: string): PickedKey[] | null {
    const c = this.confirmed
    const age = c ? this.a.clock.now() - c.at : -1
    return c && c.email === email && c.code === code && age >= 0 && age < PICKUP_KEYS_KEEP_MS ? c.keys : null
  }

  /**
   * Confirm the code and activate the key that fits this build (`chosenKey`),
   * with the address it was picked up with and, for a code-locked key, the code
   * the pickup handed back. Runs inside the one-at-a-time order (`serial`), as
   * `activate` does.
   */
  protected async restoreNow(email: string, code: string): Promise<RestoreResult> {
    const picked = await this.confirmPickup(email, code)
    if (!picked.ok) return picked
    const choice = chosenKey(picked.keys, this.major, this.a.clock.now())
    if ('refused' in choice) return { ok: false, error: choice.refused }
    const result = await this.activatePicked(email, picked.keys[choice.index] as PickedKey)
    // Activated: the keys (and a lock's single-use code among them) are done with.
    if (result.ok) this.confirmed = null
    return result
  }

  /** Activate a picked key as `activate(key, { email, code })` would, the address as the pickup sent it. */
  private activatePicked(email: string, key: PickedKey): Promise<RestoreResult> {
    const sent = pickupAsk(email, null)
    const address = 'send' in sent ? sent.send.email : email
    return this.activateNow(key.key, { email: address, ...(key.activationCode ? { code: key.activationCode } : {}) })
  }
}
