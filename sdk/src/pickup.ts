/**
 * Buying from the app with no key typed, decided without I/O: the purchase
 * secret `purchaseUrl` keeps (`newPurchaseSecret`), the reference to it a link
 * carries (`purchaseReference`, `purchaseLink`, built as `upgradeUrl`'s link
 * is: `referencedLink`), how long a secret is held (`purchaseTokenKept`), when
 * `status()` asks for the key bought with it (`claimDue`), and what the
 * claim's answer saves and says (`claimOutcome`). purchases.ts makes the
 * requests and the saves.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { LeaseClaims } from '@keygrant/shared'
import type { DeviceKind, LicenseStatus, StoredState } from './types.js'
import { activationIdentity, type Device } from './device.js'
import { CLAIM_EAGER_MS, CLAIM_WAIT_MS, LEASED, NO_PURCHASE, PURCHASE_TOKEN_MS, keptWith, leaseStatus, type LeaseCheck } from './offline.js'
import { noAnswer, parseClaimBody } from './wire.js'

/** What starts every purchase reference, so the server tells one apart from an activation id or a key. */
export const PURCHASE_REFERENCE_PREFIX = 'kgp_'

/** The query parameter a payment link names its checkout's buyer by. */
const REFERENCE = 'client_reference_id'

/**
 * A new purchase secret: the base64url (no padding) of 32 bytes from the
 * platform's CSPRNG, 43 characters. It stays on the device (`purchaseToken`)
 * and is sent only in the claim: a link carries the reference to it
 * (`purchaseReference`), so a link that leaks (browser history, the tenant's
 * Stripe session) claims nothing. Random, and never the fingerprint: a
 * fingerprint is no secret.
 */
export function newPurchaseSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The reference a payment link carries for `secret`: `kgp_` and the base64url
 * (no padding) of the SHA-256 of the secret's UTF-8 bytes, 47 characters. The
 * checkout keeps it on the key it mints; the server derives it from the
 * secret a claim sends, to find that key.
 */
export function purchaseReference(secret: string): string {
  return `${PURCHASE_REFERENCE_PREFIX}${createHash('sha256').update(secret, 'utf8').digest('base64url')}`
}

/** The link `purchaseUrl` answers for a held `secret`: the link with its reference (`referencedLink`). */
export function purchaseLink(link: string, secret: string): string {
  return referencedLink(link, purchaseReference(secret))
}

/** A payment link read as an absolute URL; a TypeError for anything else (a path, a bare host). */
export function absoluteLink(link: string): URL {
  return new URL(link)
}

/**
 * `link` with `reference` as its one `client_reference_id`. The link is read
 * as an absolute URL (`absoluteLink`), which writes it in its normal form,
 * and its query is then edited as text: every parameter named exactly
 * `client_reference_id` (its text before the first `=`, or all of it) and
 * every empty one is left out, the others are kept as written and in their
 * order, and `client_reference_id=<reference>` (percent-encoded as a URI
 * component) is added last. The fragment is kept.
 */
export function referencedLink(link: string, reference: string): string {
  const url = absoluteLink(link)
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== REFERENCE)
  url.search = [...kept, `${REFERENCE}=${encodeURIComponent(reference)}`].join('&')
  return url.href
}

/**
 * Whether the stored purchase token is still held at `now` (the guarded
 * clock): there is one, stamped with when `purchaseUrl` last handed it out
 * (`purchaseTokenAt`), and less than PURCHASE_TOKEN_MS has passed since. A
 * stamp ahead of `now` holds it too: no time has passed that can be measured.
 */
export function purchaseTokenKept(state: StoredState, now: number): boolean {
  if (typeof state.purchaseToken !== 'string' || typeof state.purchaseTokenAt !== 'number') return false
  return now - state.purchaseTokenAt < PURCHASE_TOKEN_MS
}

/**
 * Whether `status()` asks the claim now, unforced (`refresh()` and
 * `startTrial()` always ask). Only while the link is fresh: less than
 * CLAIM_EAGER_MS since `purchaseUrl` last handed it out (`purchaseTokenAt`,
 * judged at `now`, the guarded clock; a stamp ahead of `now` is fresh), so an
 * abandoned checkout does not put the network in front of every launch for a
 * month. And only once the wait is over (`claimAskedAt`, judged at `clockNow`,
 * the device clock, as `askDue`: the wait is courtesy, not protection): not
 * asked since the link, the device clock set back before the last ask, or
 * CLAIM_WAIT_MS since it.
 */
export function claimDue(state: StoredState, clockNow: number, now: number): boolean {
  const at = state.purchaseTokenAt
  if (typeof at !== 'number' || now - at >= CLAIM_EAGER_MS) return false
  const asked = state.claimAskedAt
  return asked === undefined || clockNow < asked || clockNow - asked >= CLAIM_WAIT_MS
}

/** At most this many fingerprints in a claim's `fingerprints`: the server's bound. */
export const MAX_CLAIM_FINGERPRINTS = 4

/** At most this many characters (UTF-16 units) in each of a claim's `fingerprints`: the server's bound. */
export const MAX_CLAIM_FINGERPRINT_LENGTH = 200

/** What a claim sends (`claimRequest`). */
export interface ClaimRequest {
  /** The purchase secret. */
  token: string
  fingerprint: string
  fingerprintKind?: DeviceKind
  fingerprints?: string[]
  name?: string
  major: number
}

/**
 * The claim's body, or null when none is sent. The fingerprint is a first
 * activation's (device.ts `activationIdentity`: the device's own, else the host
 * name), and from `status()` and `refresh()` (`start` false) only the device's
 * own: a claim under the host-name fallback could take the seat under a
 * fingerprint the next ask does not send, so with no own fingerprint nothing is
 * sent (and nothing saved). `fingerprints` is every fingerprint the run read,
 * its own first, then the host name and any other alternates, whether or not
 * the device is held (they only match this claim to an earlier one, and judge
 * no seat), within the server's bounds: those of 1 to
 * MAX_CLAIM_FINGERPRINT_LENGTH characters, the first MAX_CLAIM_FINGERPRINTS of
 * them; left out when none is. A body with too many, or one too long, is
 * refused with an error word, which would drop the secret.
 */
export function claimRequest(input: { secret: string; device: Device; name?: string; major: number; start: boolean }): ClaimRequest | null {
  const { device } = input
  if (!input.start && device.own === null) return null
  const identity = activationIdentity(device)
  if (identity === null) return null
  const fingerprints = device.fingerprints
    .filter((fingerprint) => fingerprint.length >= 1 && fingerprint.length <= MAX_CLAIM_FINGERPRINT_LENGTH)
    .slice(0, MAX_CLAIM_FINGERPRINTS)
  return {
    token: input.secret,
    fingerprint: identity.fingerprint,
    ...(identity.kind ? { fingerprintKind: identity.kind } : {}),
    ...(fingerprints.length > 0 ? { fingerprints } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    major: input.major,
  }
}

/** An activation the server answered with a lease that licenses this build (`activationPatch`). */
export interface Activation {
  key: string
  activationId: string
  lease: string
  /** The lease's claims. */
  claims: LeaseClaims
  /** The time the lease was judged at. */
  now: number
  /** This build's major. */
  major: number
  /** What the activation's fingerprint hashes: none for one of unknown kind. */
  kind?: DeviceKind
}

/**
 * What an activation saves, a typed key's (license.ts) and a bought key's
 * claim (`claimOutcome`) alike, stamped as an activation: the key, the
 * activation, the lease, the major heard, the kept major (`keptWith`), any
 * refusal and wait cleared (LEASED), what the install is keyed by (cleared
 * for a fingerprint of unknown kind), and the purchase token and its stamps
 * cleared (NO_PURCHASE).
 */
export function activationPatch(a: Activation): Partial<StoredState> {
  return {
    key: a.key,
    activationId: a.activationId,
    lease: a.lease,
    checkedMajor: a.major,
    keptMajor: keptWith(undefined, a.claims, a.now, a.major),
    ...LEASED,
    deviceKind: a.kind,
    ...NO_PURCHASE,
  }
}

/** A claim's answer: its HTTP status, and its body as JSON. */
export interface ClaimResponse {
  status: number
  json: unknown
}

/** What a claim's answer is judged from (`claimOutcome`). */
export interface ClaimInput {
  /** The answer; null when there was none (it threw or timed out, or no fingerprint could be sent). */
  response: ClaimResponse | null
  /**
   * The offline check (`checkLease`, as of `now`, for the key and activation
   * it came with, on this device) of the lease a 200 carried with a key and
   * an activation id; absent otherwise.
   */
  check?: LeaseCheck
  /** The device clock when the claim was asked: where the wait before asking again starts. */
  clockNow: number
  /** The time the lease was judged at: the guarded clock, reconciled to the server's. */
  now: number
  /** This build's major. */
  major: number
  /** What the claim's fingerprint hashes. */
  kind?: DeviceKind
}

/** What a claim's answer does: `bought` licenses, `kept` waits, `dropped` lets the secret go. */
export type ClaimOutcome =
  | { result: 'bought'; status: LicenseStatus; patch: Partial<StoredState> }
  | { result: 'kept' | 'dropped'; status: null; patch: Partial<StoredState> }

/**
 * What a claim's answer saves and says:
 *  - a 200 with a key, an activation id and a lease (strings) whose lease
 *    licenses this build here (`check`): saved exactly as `activate(key)`
 *    saves (`activationPatch`), and licensed (`leaseStatus`);
 *  - a 200 with all three whose lease does not license this build here: the
 *    secret dropped (the customer has the key by email, and typing it gives
 *    the proper error);
 *  - a 200 `{pending: true}` ("not bought yet"), no answer, a 5xx or a 429,
 *    and any other answer with no error word (a captive portal's page, an old
 *    server's 404 page): the secret kept, and the wait started
 *    (`claimAskedAt`);
 *  - any other answer with an error word (`spent`, `pickup-off`, a refusal):
 *    the secret dropped.
 * Only a bought key gives a status: otherwise the caller answers as it would
 * with no secret held.
 */
export function claimOutcome(input: ClaimInput): ClaimOutcome {
  const { response, check } = input
  const kept: ClaimOutcome = { result: 'kept', status: null, patch: { claimAskedAt: input.clockNow } }
  const dropped: ClaimOutcome = { result: 'dropped', status: null, patch: { ...NO_PURCHASE } }
  if (response === null || noAnswer(response.status)) return kept
  const body = parseClaimBody(response.json)
  const { key, activationId, lease } = body
  if (response.status === 200 && key !== undefined && activationId !== undefined && lease !== undefined) {
    if (!check?.ok) return dropped
    const patch = activationPatch({ key, activationId, lease, claims: check.claims, now: input.now, major: input.major, kind: input.kind })
    return { result: 'bought', status: leaseStatus(check, key), patch }
  }
  if (response.status === 200 && body.pending) return kept
  return body.error === undefined ? kept : dropped
}
