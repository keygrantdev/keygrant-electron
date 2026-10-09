/**
 * The online validate (a renewal), decided without I/O: when `status()` asks
 * the server while it holds a lease that licenses this build
 * (`asksOnValidLease`, license.ts), and what an ask's answer saves and says
 * (`renewalOutcome`, engine.ts `renew`). The engine makes the request, judges
 * the lease a 200 carried, and saves the patch as the answer to its ask.
 *
 * Licensing fails in favour of the paying customer: only an explicit verdict
 * (a lease, or a refusal `refusalOf` names) gives a status. No answer at all,
 * a 5xx, a 429, any other error, and a 200 without a lease that can be used
 * give none, and the caller's own answer (a valid lease, a stored refusal, the
 * lease's own end) stands.
 */
import { OPEN_MAJOR, type LeaseClaims } from '@keygrant/shared'
import type { LicenseStatus, StoredState } from './types.js'
import type { Device } from './device.js'
import {
  ASK_AGAIN_MS,
  LEASED,
  RETRY_UNANSWERED_MS,
  askDue,
  keptWith,
  keyedBy,
  leaseStatus,
  refusalPatch,
  renewsEarly,
  type LeaseCheck,
} from './offline.js'
import { errorOf, noAnswer, parseLeaseBody, refusalOf } from './wire.js'

/** What a validate came back with: its HTTP status, and its body as JSON (null or undefined when it had none). */
export interface ValidateResponse {
  status: number
  json: unknown
}

/** What an ask's answer is judged from. */
export interface RenewalInput {
  /** The answer; null when there was none at all (the request threw or timed out). */
  response: ValidateResponse | null
  /**
   * The offline check (offline.ts `checkLease`) of the lease the 200 carried,
   * made as of `now` on this device; absent when it carried none.
   */
  check?: LeaseCheck
  /** When the ask was made, by the device clock (ms): where the wait before asking again starts. */
  askedAt: number
  /** The time the lease was judged at (ms): the guarded clock, reconciled to the server's (engine.ts `serverNow`). */
  now: number
  /** This build's major, sent with the ask. */
  major: number
  /** The stored key, which a status names. */
  key: string | undefined
  /** The stored kept major (offline.ts `keptWith`). */
  keptMajor: number | undefined
  /**
   * Who this device is, as the ask read it: a machine id read keys the install
   * (`keyedBy`), and a device refusal is held to its own claim (`refusalPatch`).
   */
  device: Pick<Device, 'kind' | 'ownClaim'>
}

/** What an ask's answer does. */
export interface RenewalOutcome {
  /** Whether the server answered at all: false for no answer, a 5xx or a 429. */
  answered: boolean
  /** The status the answer gives; null when it gives none, and the caller's own answer stands. */
  status: LicenseStatus | null
  /** What is saved, as the answer to the ask (offline.ts `merged`, basis `answer`). */
  patch: Partial<StoredState>
}

/**
 * What a validate's answer saves and says. Every patch carries
 * `deviceKind: machine` when this run read a machine id (`keyedBy`): the seat
 * is re-keyed by it whatever the answer, so the install is keyed by it from now
 * on.
 *
 *  - no answer at all: wait RETRY_UNANSWERED_MS, no status;
 *  - a 5xx or a 429: wait ASK_AGAIN_MS, no status;
 *  - a 200 with a lease that licenses this build: the lease, the major heard
 *    (`checkedMajor`), the kept major (`keptWith`), any refusal and wait
 *    cleared (LEASED): licensed;
 *  - a 200 with a lease the server stands behind that does not license this
 *    build or this device (`upgrade`, `outdated`, `device`): kept as above,
 *    with no kept major, so every later status says the same offline: invalid;
 *  - any other 200 (no lease, or one expired or not this licence's): the major
 *    heard and a wait of ASK_AGAIN_MS, no status; never a lockout on a bad body;
 *  - a refusal (`refusalOf` of the body's error word, on any status but a 200,
 *    a 5xx or a 429): the major heard, the wait, and the refusal
 *    (`refusalPatch`): invalid with it;
 *  - any other answer (a proxy's 4xx, an unknown product, a body that is not
 *    an object): the major heard and the wait, no status.
 */
export function renewalOutcome(input: RenewalInput): RenewalOutcome {
  const { response, askedAt, major, device } = input
  const keyed = keyedBy(device)
  if (response === null) {
    return { answered: false, status: null, patch: { backoffSince: askedAt, backoffMs: RETRY_UNANSWERED_MS, ...keyed } }
  }
  const backoff = { backoffSince: askedAt, backoffMs: ASK_AGAIN_MS, ...keyed }
  if (noAnswer(response.status)) return { answered: false, status: null, patch: backoff }
  if (response.status === 200) return leaseOutcome(input, response, backoff)
  // Lock out ONLY on an explicit definitive negative verdict. Everything else
  // (a proxy's or WAF's 4xx, an unknown-product 404, a malformed-body 400, any
  // answer not recognised) is treated like a network failure, so a still-valid
  // lease is never revoked by an ambiguous answer.
  const refused = refusalOf(errorOf(response.json))
  // On a verdict, the next status() must not license offline what the server
  // has just refused (`refusalPatch`: what is dropped, what is kept).
  const verdictPatch = refused ? refusalPatch(refused, major, device) : {}
  return {
    answered: true,
    status: refused ? { state: 'invalid', reason: refused, key: input.key } : null,
    patch: { checkedMajor: major, ...backoff, ...verdictPatch },
  }
}

/** A 200's answer (`renewalOutcome`): by the lease it carried, as checked here. */
function leaseOutcome(input: RenewalInput, response: ValidateResponse, backoff: Partial<StoredState>): RenewalOutcome {
  const { lease } = parseLeaseBody(response.json)
  const { check, major, device } = input
  // 200 but no usable lease (none, or one expired or not this licence's here):
  // nothing to heal with; whatever the caller has is kept (fail in favour of
  // the customer) rather than locked out on a bad body.
  if (!lease || !check || !standsBehind(check)) return { answered: true, status: null, patch: { checkedMajor: major, ...backoff } }
  // The status the lease gives here (offline.ts `leaseStatus`).
  const status = leaseStatus(check, input.key)
  // A lease the server stands behind that does not license this build, or
  // this device: kept, so every later status() says the same offline.
  if (!check.ok) return { answered: true, status, patch: { lease, checkedMajor: major, ...LEASED, ...keyedBy(device) } }
  // Licensed, with the check's test flag and the lease's entitlements.
  const keptMajor = keptWith(input.keptMajor, check.claims, input.now, major)
  return { answered: true, status, patch: { lease, checkedMajor: major, keptMajor, ...LEASED, ...keyedBy(device) } }
}

/** Whether the server stands behind a checked lease: it licenses this build, or it is for another build or device. */
function standsBehind(check: LeaseCheck): boolean {
  return check.ok || check.reason === 'upgrade' || check.reason === 'outdated' || check.reason === 'device'
}

/** What the decision to ask on a valid lease reads (`asksOnValidLease`). */
export interface ValidLeaseAsk {
  /** The lease's claims: its `major`, and its `iat` and `exp` (seconds). */
  claims: LeaseClaims
  /** The stored state: the major the server last heard (`checkedMajor`), and the wait (`backoffSince`, `backoffMs`). */
  state: StoredState
  /** This build's major. */
  major: number
  /** The guarded clock (ms), which the lease's end is judged by. */
  now: number
  /** The device clock as it is (ms), which the wait is judged by (`askDue`). */
  clockNow: number
}

/**
 * Whether `status()`, holding a lease that licenses this build, asks the
 * server now (unforced; `refresh()` always asks). When the server should hear
 * from this device before the lease runs out: a newer major than the server
 * last heard, on an open lease (`major >= OPEN_MAJOR`; else it might not hear
 * of it until the key's upgrade window has closed), or a lease nearing its end
 * (`renewsEarly`, by the guarded clock), renewed early so it rarely runs out
 * while the device is offline. And only once the wait after the last ask is
 * over (`askDue`, by the device clock). The ask is bounded
 * (STATUS_CHECK_TIMEOUT_MS) and the valid lease is the answer when it gets no
 * verdict.
 */
export function asksOnValidLease(input: ValidLeaseAsk): boolean {
  const { claims, state, major } = input
  const newMajor = claims.major >= OPEN_MAJOR && major > (state.checkedMajor ?? 0)
  const due = newMajor || renewsEarly(claims, input.now)
  return due && askDue(state, input.clockNow, false)
}
