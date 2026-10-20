/**
 * Key pickup (sdk-contract.md section 13; the server's integration.md section
 * 20): the pieces of `pickUp` and `restoreByEmail` that need no engine state.
 * What a person typed is checked here before anything is sent (`pickupAsk`),
 * the server's refusals become the SDK's errors (`pickupRefusal`), its answer
 * is read leniently (`pickedKeysOf`), and the key a restore activates is chosen
 * (`chosenKey`).
 */
import { entitlementsOf } from '@keygrant/shared'
import type { LicenseError, PickedKey, PickupError } from './types.js'
import { MAX_KEY, enteredCode, enteredEmail } from './wire.js'

/**
 * What a pickup call sends for what a person typed, or the error that refuses it
 * before anything is sent. `code` null is the ask for a code (`pickUp(email)`);
 * a code, even a blank one, is a confirm (`pickUp(email, code)`).
 *
 * The address is trimmed as an activation's is (wire.ts `enteredEmail`): a blank
 * one, and one longer than any address, is `invalid-email`. The code is entered
 * as an activation's is (`enteredCode`): a blank one, and one that is not six
 * digits, is `wrong-code`, refused here without costing the address one of its
 * wrong tries. The address is judged first.
 */
export function pickupAsk(email: unknown, code: unknown | null): { send: { email: string; code?: string } } | { refused: PickupError } {
  const entered = enteredEmail(email)
  if ('tooLong' in entered || entered.send === null) return { refused: 'invalid-email' }
  if (code === null) return { send: { email: entered.send } }
  const typed = enteredCode(code)
  if ('malformed' in typed || typed.send === null) return { refused: 'wrong-code' }
  return { send: { email: entered.send, code: typed.send } }
}

/**
 * How long the keys a confirm answered are kept in memory (never stored), for a
 * confirm or a restore with the same address and code: a code's own life. The
 * code is spent by the first confirm, so a restore whose activation got no
 * answer, or a restore after `pickUp(email, code)`, needs no new code.
 */
export const PICKUP_KEYS_KEEP_MS = 10 * 60_000

/** The server's words a pickup answers as themselves. */
const OWN_WORDS = new Set(['pickup-disabled', 'wrong-code', 'code-expired', 'too-many-attempts', 'try-again'])

/** The errors a refusal's `retryAfter` (seconds, from its body) is kept on: the two that say when to try again. */
const WAITS = new Set(['too-many-attempts', 'try-again'])

/**
 * The error a refused pickup call answers, from the server's body (`json`, as
 * parsed, null for none): each pickup word as itself; the per-network limit
 * (`rate-limited`, 429) as `too-many-attempts`; a count that could not be made
 * (`unavailable`, 503) as `try-again`; a body the server refused to read
 * (`invalid-request`, 400) as `invalid-email`, since what a person typed is all
 * a pickup sends; and anything else, a proxy's page or an unknown product
 * included, as `network`. `retryAfter` is kept, on the two that wait, when the
 * body gives it as a whole number of seconds.
 */
export function pickupRefusal(json: unknown): { error: PickupError; retryAfter?: number } {
  const body = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const word = body.error
  const error: PickupError =
    typeof word === 'string' && OWN_WORDS.has(word)
      ? (word as PickupError)
      : word === 'rate-limited'
        ? 'too-many-attempts'
        : word === 'unavailable'
          ? 'try-again'
          : word === 'invalid-request'
            ? 'invalid-email'
            : 'network'
  const wait = body.retryAfter
  return WAITS.has(error) && wholeNumber(wait) ? { error, retryAfter: wait } : { error }
}

/** A JSON number that is a whole number from 0 to 2^53 - 1. */
function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A JSON object as a record, or null for anything else (an array included). */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * The keys a confirm's 200 answers, read leniently, in the order given; null
 * when the body is not a pickup's answer at all (not an object, or `keys` not
 * an array), which the SDK takes as no answer (`network`). A member that is not
 * an object with a `key` (text, 1 to MAX_KEY UTF-16 units) is left out; every
 * other field falls back when it is not what it should be (`pickedKey`).
 */
export function pickedKeysOf(json: unknown): PickedKey[] | null {
  const keys = record(json)?.keys
  if (!Array.isArray(keys)) return null
  return keys.flatMap((raw) => {
    const picked = pickedKey(raw)
    return picked ? [picked] : []
  })
}

/**
 * One key of a confirm's answer, or null when it has no key. `model` and
 * `state` are texts ('' otherwise), `modelName` a text or null, `entitlements`
 * read as a lease's `ent` is (`entitlementsOf`), `expiresAt` a whole number or
 * null, `versions` as `versionsOf`, `deviceLimit` and `activeDevices` whole
 * numbers (0 otherwise), `held` true only for JSON true, `sale` kept only with
 * a text `id` and whole `index` and `size` of at least 1, and `activationCode`
 * kept only as exactly six ASCII digits.
 */
function pickedKey(raw: unknown): PickedKey | null {
  const r = record(raw)
  if (r === null || typeof r.key !== 'string' || r.key.length === 0 || r.key.length > MAX_KEY) return null
  const sale = record(r.sale)
  const keptSale = sale && typeof sale.id === 'string' && atLeastOne(sale.index) && atLeastOne(sale.size) ? { sale: { id: sale.id, index: sale.index, size: sale.size } } : {}
  const code = typeof r.activationCode === 'string' && /^[0-9]{6}$/.test(r.activationCode) ? { activationCode: r.activationCode } : {}
  return {
    key: r.key,
    model: typeof r.model === 'string' ? r.model : '',
    modelName: typeof r.modelName === 'string' ? r.modelName : null,
    state: typeof r.state === 'string' ? r.state : '',
    entitlements: entitlementsOf(r.entitlements),
    expiresAt: wholeNumber(r.expiresAt) ? r.expiresAt : null,
    versions: versionsOf(r.versions),
    deviceLimit: wholeNumber(r.deviceLimit) ? r.deviceLimit : 0,
    activeDevices: wholeNumber(r.activeDevices) ? r.activeDevices : 0,
    held: r.held === true,
    ...keptSale,
    ...code,
  }
}

/** A whole number of at least 1. */
function atLeastOne(value: unknown): value is number {
  return wholeNumber(value) && value >= 1
}

/**
 * A key's versions as read: null for a key not yet bound (which covers
 * whichever build activates it first), and for anything that is not an object
 * with a whole `minMajor`; else `minMajor`, and `maxMajor` and `upgradeUntil`
 * each a whole number or null.
 */
function versionsOf(raw: unknown): PickedKey['versions'] {
  const v = record(raw)
  if (v === null || !wholeNumber(v.minMajor)) return null
  return {
    minMajor: v.minMajor,
    maxMajor: wholeNumber(v.maxMajor) ? v.maxMajor : null,
    upgradeUntil: wholeNumber(v.upgradeUntil) ? v.upgradeUntil : null,
  }
}

/**
 * Whether a key covers the build's `major` at `now`: a key not yet bound always
 * does; else from `minMajor` up to `maxMajor` (none: no top), and every major
 * from `minMajor` up while `upgradeUntil` (ms) is after `now`.
 */
export function covers(versions: PickedKey['versions'], major: number, now: number): boolean {
  if (versions === null) return true
  if (major < versions.minMajor) return false
  return versions.maxMajor === null || major <= versions.maxMajor || (versions.upgradeUntil !== null && versions.upgradeUntil > now)
}

/**
 * The key `restoreByEmail` activates, by its place in `keys` (the server's
 * order: first sold first), or the error it answers. Of the keys that cover the
 * build's major: the first this device already holds a seat on (`held`, a
 * reinstall takes that seat back), else the first with a free seat, else the
 * first (its activation answers `limit`). None at all is `no-key`; none that
 * covers the build is `upgrade` when one of them is for an older major than the
 * build (buy an upgrade), else `outdated` (update the app).
 */
export function chosenKey(keys: readonly PickedKey[], major: number, now: number): { index: number } | { refused: 'no-key' | Extract<LicenseError, 'upgrade' | 'outdated'> } {
  if (keys.length === 0) return { refused: 'no-key' }
  const covering = keys.map((k, index) => ({ k, index })).filter(({ k }) => covers(k.versions, major, now))
  const pick = covering.find(({ k }) => k.held) ?? covering.find(({ k }) => k.activeDevices < k.deviceLimit) ?? covering[0]
  if (pick) return { index: pick.index }
  return keys.some((k) => k.versions !== null && k.versions.minMajor <= major) ? { refused: 'upgrade' } : { refused: 'outdated' }
}
