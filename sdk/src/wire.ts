/**
 * What the SDK's engine (license.ts) sends and reads on the wire, and the small
 * pieces of it that need no engine state: the server's error words, the
 * bounds the endpoints hold strings to, and the shapes of their answers.
 */
import { MAX_LICENSE_KEY, type Entitlements } from '@keygrant/shared'
import type { LicenseError, LicenseStatus, Refusal } from './types.js'

/** Map a server error string to an SDK LicenseError. */
export function mapServerError(error: unknown): LicenseError {
  switch (error) {
    case 'invalid-key':
      return 'invalid-key'
    case 'limit':
      return 'limit'
    case 'revoked':
    case 'expired':
      return 'revoked'
    case 'upgrade-required':
      return 'upgrade'
    case 'update-required':
      return 'outdated'
    default:
      return 'network'
  }
}

/** What `/v1/products/<slug>/activate` accepts for a device name. Longer is truncated, not refused. */
export const MAX_DEVICE_NAME = 120
/** What it accepts for a licence key. A longer one is not a key it could hold. */
export const MAX_KEY = MAX_LICENSE_KEY

/**
 * The key a person entered, NORMALISED, and the normalised key is the one that
 * is sent and stored; or null when it cannot be a key at all.
 *
 * A key arrives by pasting it out of an email or by being typed off a receipt.
 * A paste carries a trailing newline more often than not, and a person typing
 * carries whatever case they type in. The lookup on the server is an exact
 * match against a key format with no lower case in it, so both of those were a
 * customer who had paid being told their key was invalid; and, at the
 * boundary, a 120-character key with a newline after it being refused for
 * being 121.
 *
 * Nothing at all is not a key, and is knowable without asking anybody. Nor is
 * one longer than the endpoint accepts, which this product never issued:
 * refused by name here, since sent on it comes back a 400 and is reported as
 * `network`, which tells the person to check their connection about something
 * they typed.
 */
export function enteredKey(key: string): string | null {
  const entered = key.trim().toUpperCase()
  return entered && entered.length <= MAX_KEY ? entered : null
}

/** Whether two licence keys are the same key: the server matches them without regard to case. */
export function sameKey(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase()
}

/**
 * Cut a string to `max` UTF-16 units without splitting a character.
 *
 * `slice` counts units, and an emoji or a CJK extension is two of them: cutting
 * between the halves leaves a lone surrogate, which is not a character and which
 * some encoders turn into a replacement mark. A device name is a label; it can
 * lose its last emoji rather than its last half-emoji.
 */
export function trimToLength(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(max - 1)
  // A high surrogate at the end has lost its pair.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * A status's `entitlements` member for a lease's `ent`: the entitlements, a
 * frozen copy, when there are any; nothing when there are none, so a lease that
 * grants nothing gives a status with no `entitlements` member at all (as `test`
 * is absent rather than false). Copied by spread, which defines each member, so
 * one named `__proto__` stays an entitlement (an assignment, as `Object.assign`
 * makes, would take it for the copy's prototype).
 */
export function entitled(ent: Entitlements | undefined): { entitlements?: Entitlements } {
  if (ent === undefined || Object.keys(ent).length === 0) return {}
  return { entitlements: Object.freeze({ ...ent }) }
}

export function errorOf(json: unknown): unknown {
  return typeof json === 'object' && json != null ? (json as { error?: unknown }).error : undefined
}

/** Extract lease/activationId from a server body, keeping only string values. */
export function parseLeaseBody(json: unknown): { lease?: string; activationId?: string } {
  if (typeof json !== 'object' || json === null) return {}
  const b = json as Record<string, unknown>
  return {
    lease: typeof b.lease === 'string' ? b.lease : undefined,
    activationId: typeof b.activationId === 'string' ? b.activationId : undefined,
  }
}

/** Validate the (unsigned) trial response body. Returns null if malformed. */
export function parseTrialBody(json: unknown): { trialStart: number; trialEndsAt: number; lease?: string } | null {
  if (typeof json !== 'object' || json === null) return null
  const b = json as Record<string, unknown>
  if (typeof b.trialStart !== 'number' || typeof b.trialEndsAt !== 'number') return null
  return { trialStart: b.trialStart, trialEndsAt: b.trialEndsAt, lease: typeof b.lease === 'string' ? b.lease : undefined }
}

/** Smallest defined timestamp, or undefined if none given. */
export function earliest(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v != null)
  return defined.length ? Math.min(...defined) : undefined
}

/**
 * `work`, or a rejection once `ms` has passed, whichever comes first. The SDK's
 * own bound on a call, kept whatever the HTTP adapter does with `timeoutMs`.
 */
export function withTimeout<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * A call's grace: over when its time is up, or as soon as the call settles
 * (`cancel`), so a finished call leaves no timer behind to hold a process open.
 */
export function graceTimer(ms: number): { over: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let end: () => void = () => undefined
  const over = new Promise<void>((resolve) => {
    end = resolve
    timer = setTimeout(resolve, ms)
  })
  return {
    over,
    cancel: () => {
      clearTimeout(timer)
      end()
    },
  }
}

/**
 * The definitive refusal a validate's error is, or null for any other error,
 * which is never taken as a verdict (a proxy's 4xx, an unknown product, a body
 * the server could not read).
 */
export function refusalOf(error: unknown): Refusal | null {
  if (error === 'upgrade-required') return 'upgrade'
  if (error === 'update-required') return 'outdated'
  if (error === 'revoked' || error === 'expired' || error === 'deactivated') return 'revoked'
  // The server's own check of this device's fingerprints against the seat.
  if (error === 'device') return 'device'
  return null
}

/** Whether a response is no answer at all: an outage (5xx) or a refusal to serve now (429). */
export function noAnswer(status: number): boolean {
  return status >= 500 || status === 429
}

/**
 * How long a check `status()` makes on a valid lease (a newer major, or an
 * early renewal) may hold it up. Short, because the app is running on a lease
 * that is valid either way, so a slow network should cost a status call
 * seconds, not minutes. A blocking check with a short bound, rather than one
 * left running in the background, keeps `status()` a single answer: what the
 * server said if it said it in time, the valid lease otherwise.
 */
export const STATUS_CHECK_TIMEOUT_MS = 5_000

/** The outcome of an online validate: the server's verdict, or no answer at all. */
export type Renewal = { answered: true; status: LicenseStatus | null } | { answered: false }
