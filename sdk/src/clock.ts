/**
 * The clock guard (anti clock-rollback), decided without I/O: the time a lease
 * is judged at, never earlier than the latest the device has seen
 * (`guardedNow`); where a lease the server has just signed brings the guard
 * back to after a clock that jumped ahead (`clockCorrection`, engine.ts
 * `serverNow`); and the latest time seen that a save writes (`savedLastSeen`,
 * engine.ts `save`).
 */
import { sameKey } from './wire.js'

/**
 * How far the clock guard may run ahead of the time the server signed a fresh
 * lease before it is brought back (engine.ts `serverNow`). Wider than any clock
 * skew worth correcting; narrower than a clock that jumped.
 */
export const CLOCK_TOLERANCE_MS = 60 * 60_000

/**
 * Now, by the clock guard: never earlier than the latest time the device has
 * seen (`lastSeen`), so a clock put back cannot bring an expired lease back.
 */
export function guardedNow(clockNow: number, lastSeen: number | undefined): number {
  return Math.max(clockNow, lastSeen ?? 0)
}

/** A fresh lease's claims as the clock guard reads them (`clockCorrection`). */
export interface SignedAt {
  sub: string
  aid: string
  /** Seconds. */
  iat: number
}

/**
 * Where the clock guard should be brought back to on a lease the server has
 * just signed, or null to leave it (engine.ts `serverNow`).
 *
 * The guard only moves forward, so a clock that once jumped ahead (a dead CMOS
 * battery, a mistyped date) and was put right left it there, and every lease, a
 * fresh one included, read as expired even online. The server's signing time
 * (`iat`) is better evidence: when the guard is MORE than CLOCK_TOLERANCE_MS
 * past it, the guard comes back to the device clock, never below `iat`.
 *
 * Only a lease signed for THIS key (without regard to case) and activation, and
 * no older than the lease the device holds (`heldIat`), moves it. `claims` is
 * the fresh lease's, verified (valid or merely expired); undefined when it did
 * not verify, which moves nothing.
 */
export function clockCorrection(input: {
  clockNow: number
  lastSeen: number | undefined
  claims: SignedAt | undefined
  heldIat: number | undefined
  key: string
  activationId: string
}): number | null {
  const { claims } = input
  if (claims === undefined || !sameKey(claims.sub, input.key) || claims.aid !== input.activationId) return null
  if ((input.lastSeen ?? 0) - claims.iat * 1000 <= CLOCK_TOLERANCE_MS) return null
  if (input.heldIat !== undefined && claims.iat < input.heldIat) return null
  return Math.max(input.clockNow, claims.iat * 1000)
}

/**
 * The latest time seen (`lastSeen`) that a save writes, onto the state as
 * stored when it saves (`stored`): the guard brought back on the server's
 * evidence (`guard`, a `clockCorrection`) exactly as given when the save
 * carries one; otherwise never earlier than what is stored, nor than the
 * device clock now, so the guard only ever moves forward on its own.
 */
export function savedLastSeen(stored: number | undefined, clockNow: number, guard: number | undefined): number {
  return guard ?? Math.max(stored ?? 0, clockNow)
}
