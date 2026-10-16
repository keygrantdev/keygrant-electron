/**
 * Metered uses, decided without I/O (the SDK contract, section 12): what `use()` may ask for, whether it asks
 * the server now, what an answer does, what a device may spend while it gets none, the figures a status shows,
 * and what the journal reports and what the server's answers confirm of it. How the journal lands on the stored
 * state is journal.ts; the engine that makes the request is spend.ts.
 *
 * A meter never takes a licence away: nothing here is read to decide whether the app is licensed.
 */
import { MAX_METER_USES, metersOf, type LeaseClaims, type Meters } from '@keygrant/shared'
import type { Device } from './device.js'
import type { BaseFigure, Confirmed, MeterFigure, MeterStatus, SpendEntry, SpendReport } from './meter-types.js'
import type { LicenseStatus, Refusal, StoredState } from './types.js'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS, keyedBy, refusalPatch } from './offline.js'
import { STATUS_CHECK_TIMEOUT_MS, errorOf, noAnswer, refusalOf } from './wire.js'

export { MAX_METER_USES }

/** The most entries the journal holds, and a report carries (the server reads no more): about 6 KB at most. */
export const MAX_PENDING_SPENDS = 64

/**
 * The most `void` entries the journal holds: a void is the take-back of a spend that was refused after it got no
 * answer, and a device out of reach that keeps trying a spend its allowance cannot cover would otherwise fill the
 * journal, leaving no room for the spends it can make. A new void past them takes the place of the oldest.
 */
export const MAX_PENDING_VOIDS = 16

/** How long an entry is kept unreported: twice the longest lease. The tenant loses a report, never the customer a use. */
export const PENDING_MAX_MS = 180 * 86_400_000

/** How long a `use` request may take: a person waits on it, so a status check's bound (`httpTimeoutMs` when shorter). */
export const USE_TIMEOUT_MS = STATUS_CHECK_TIMEOUT_MS

/** The longest meter code a call may name, in UTF-16 units: an entitlement's name. */
export const MAX_METER_CODE = 32

/** A whole number a double holds exactly (JSON reads every number as one). */
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/** A figure of a meter: a non-negative whole number. */
const isFigure = (value: unknown): value is number => isWhole(value) && value >= 0

/** A value as an object, or null when it is anything else (an array included). */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// --- what was asked ------------------------------------------------------------

/**
 * How many uses a call spends: `n` absent is 1; a whole number from 1 to `MAX_METER_USES` is itself; anything
 * else (0, a negative, a fraction, past the bound, not a number) is none (`invalid-amount`).
 */
export function useAmount(n: unknown): number | null {
  if (n === undefined) return 1
  return isWhole(n) && n >= 1 && n <= MAX_METER_USES ? n : null
}

/** A meter's code as a call names it: a text of 1 to 32 UTF-16 units, matched exactly; anything else is none (`no-meter`). */
export function meterCode(code: unknown): string | null {
  return typeof code === 'string' && code.length >= 1 && code.length <= MAX_METER_CODE ? code : null
}

/** What `use(meter, n)` asks for, or why it asks nothing: the amount is judged before the code. */
export function askedFor(meter: unknown, n: unknown): { meter: string; n: number } | { refused: 'invalid-amount' | 'no-meter' } {
  const amount = useAmount(n)
  if (amount === null) return { refused: 'invalid-amount' }
  const code = meterCode(meter)
  return code === null ? { refused: 'no-meter' } : { meter: code, n: amount }
}

// --- the stored fields, read leniently -----------------------------------------

/** Whether a stored entry is one the journal holds. The state is the device's own, never the server's word: what is not one is left out. */
function isEntry(value: unknown): value is SpendEntry {
  const e = asObject(value)
  return (
    e !== null &&
    typeof e.id === 'string' &&
    typeof e.meter === 'string' &&
    isWhole(e.n) &&
    e.n >= 1 &&
    isFigure(e.at) &&
    (e.kind === 'offline' || e.kind === 'unanswered' || e.kind === 'void')
  )
}

/** The journal a stored `spends` is: its entries in order, anything that is not a list or an entry left out. */
export function spendsOf(stored: unknown): SpendEntry[] {
  return Array.isArray(stored) ? stored.filter(isEntry) : []
}

/** The figures a stored `meterFigures` holds, by code: a member that is not a whole figure set with a time is left out. */
export function storedFigures(stored: unknown): Record<string, MeterFigure> {
  const all = asObject(stored)
  if (all === null) return {}
  const kept: [string, MeterFigure][] = []
  for (const [code, member] of Object.entries(all)) {
    const f = asObject(member)
    if (f !== null && isFigure(f.left) && isFigure(f.total) && isFigure(f.offline) && isFigure(f.at)) {
      kept.push([code, { left: f.left, total: f.total, offline: f.offline, resets: f.resets === true, at: f.at }])
    }
  }
  return Object.fromEntries(kept)
}

/** A spend's id: 16 bytes from the platform's secure random source, base64url with no padding (22 characters), never reused. */
export function newSpendId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The body of a `use` request: the device's check (`deviceBody`), the spend, the journal's report when there is one, and the key ids. */
export function useRequestBody(
  device: Record<string, unknown>,
  spend: { meter: string; n: number; id: string },
  reports: SpendReport[] | undefined,
  kids: string[],
): Record<string, unknown> {
  return { ...device, meter: spend.meter, n: spend.n, id: spend.id, ...(reports ? { spends: reports } : {}), kids }
}

// --- the figures -----------------------------------------------------------------

/** Uses this device spent that KeyGrant has not heard of: the `n` of a meter's `offline` and `unanswered` entries, never a `void`. */
export function unsyncedOf(spends: readonly SpendEntry[], meter: string): number {
  return spends.reduce((sum, e) => (e.meter === meter && e.kind !== 'void' ? sum + e.n : sum), 0)
}

const baseOf = (f: BaseFigure): BaseFigure => ({ left: f.left, total: f.total, offline: f.offline, resets: f.resets })

/**
 * The base figures of each meter: its stored figure (a `use` answer's) when that figure is at or after the
 * lease's own second (`iat`, seconds), else the lease's `met` member, else none, and the meter is unknown on
 * this device. A meter the newest lease no longer names, and no newer answer names, is gone.
 */
export function figuresOf(met: Meters | undefined, iat: number, stored: unknown): Record<string, BaseFigure> {
  const answered = storedFigures(stored)
  const leased = met ?? {}
  const base: [string, BaseFigure][] = []
  for (const code of new Set([...Object.keys(leased), ...Object.keys(answered)])) {
    const newer = Object.hasOwn(answered, code) && (answered[code] as MeterFigure).at >= iat * 1000
    const figure = newer ? answered[code] : Object.hasOwn(leased, code) ? leased[code] : undefined
    if (figure !== undefined) base.push([code, baseOf(figure)])
  }
  return Object.fromEntries(base)
}

/** The base figures of the lease that licenses this device and the answers stored beside it. */
export const figuresFor = (claims: Pick<LeaseClaims, 'met' | 'iat'>, state: Pick<StoredState, 'meterFigures'>): Record<string, BaseFigure> =>
  figuresOf(claims.met, claims.iat, state.meterFigures)

/** `status().meters`: each meter with base figures, its `left` net of this device's unsynced spends and never below 0. */
export function meterStatusOf(figures: Record<string, BaseFigure>, spends: readonly SpendEntry[]): Record<string, MeterStatus> {
  return Object.fromEntries(
    Object.entries(figures).map(([code, f]) => {
      const unsynced = unsyncedOf(spends, code)
      return [code, { left: Math.max(0, f.left - unsynced), total: f.total, offline: f.offline, unsynced, resets: f.resets }]
    }),
  )
}

/**
 * A `licensed` status from a key's lease with its meters (`meterStatusOf`), each status holding a copy of its
 * own; any other status, and a lease with no meter, unchanged.
 */
export function meteredStatus(status: LicenseStatus, claims: Pick<LeaseClaims, 'met' | 'iat'>, state: StoredState): LicenseStatus {
  if (status.state !== 'licensed') return status
  const meters = meterStatusOf(figuresFor(claims, state), spendsOf(state.spends))
  if (Object.keys(meters).length === 0) return status
  return { ...status, meters: Object.freeze(Object.fromEntries(Object.entries(meters).map(([code, m]) => [code, Object.freeze(m)]))) }
}

/**
 * Whether a spend with no answer is allowed, from the meter's base figures and the journal: its unsynced
 * spends with this one at most the figure's `offline` allowance and at most its `left`. Allowed, `left` is the
 * figure's less unsynced less `n`, and `limit` the most the meter's unsynced spends may come to with it (the
 * smaller of the allowance and `left`), which the landing judges again; refused, `offline-limit` with the
 * figure's less unsynced (never below 0); a meter with no base figure is `no-meter`.
 */
export function offlineSpend(
  figures: Record<string, BaseFigure>,
  spends: readonly SpendEntry[],
  meter: string,
  n: number,
): { ok: true; left: number; limit: number } | { ok: false; error: 'no-meter' } | { ok: false; error: 'offline-limit'; left: number } {
  if (!Object.hasOwn(figures, meter)) return { ok: false, error: 'no-meter' }
  const f = figures[meter] as BaseFigure
  const unsynced = unsyncedOf(spends, meter)
  const left = Math.max(0, f.left - unsynced)
  if (unsynced + n <= f.offline && n <= left) return { ok: true, left: left - n, limit: Math.min(f.offline, f.left) }
  return { ok: false, error: 'offline-limit', left }
}

// --- when to ask ---------------------------------------------------------------------

/**
 * Whether the journal's wait is running at `now` (the guarded clock): with k `unanswered` and `void` entries
 * (k at least 1), until `min(ASK_AGAIN_MS, RETRY_UNANSWERED_MS x 2^(k-1))` after the newest of them was opened:
 * a minute after one, two after two, four, eight, and an hour from the seventh on. A device out of reach asks
 * less and less often, so a person is not kept waiting on a timeout at every use. An entry from after `now` (a
 * clock that jumped ahead and was corrected) is no wait that can be measured, as a device clock set back ends
 * the first wait: it is left out, of the count and of the newest, and the others wait as they would alone, so a
 * corrected clock never stops the asking for days.
 */
export function journalWaiting(spends: readonly SpendEntry[], now: number): boolean {
  const opened = spends.filter((e) => e.kind !== 'offline' && e.at <= now)
  if (opened.length === 0) return false
  const newest = Math.max(...opened.map((e) => e.at))
  return now < newest + Math.min(ASK_AGAIN_MS, RETRY_UNANSWERED_MS * 2 ** (opened.length - 1))
}

/**
 * Whether the wait of an uncovered spend runs at `now` (the guarded clock): a `void`, the take-back of an
 * uncovered spend that was asked and got no answer, opened less than RETRY_UNANSWERED_MS ago. An outage then
 * costs such a spend one ask a minute, and the journal one void a minute at most. A void opened after `now`,
 * or after the device clock (`clockNow`), is no wait that can be measured, as a device clock set back ends the
 * first wait, and is left out: a clock that is behind the guard, which then stands still, never refuses an
 * online-only meter to a customer who is online.
 */
export function voidWaiting(spends: readonly SpendEntry[], now: number, clockNow: number): boolean {
  return spends.some((e) => e.kind === 'void' && e.at <= now && e.at <= clockNow && now < e.at + RETRY_UNANSWERED_MS)
}

/**
 * What `useAsksNow` reads: the stored wait and journal, the device clock (the first wait's) and the guarded one
 * (the journal's), and whether the offline allowance would cover the spend (`covered`: `offlineSpend` allows it).
 */
export interface UseAsk {
  state: Pick<StoredState, 'backoffSince' | 'backoffMs' | 'spends'>
  clockNow: number
  now: number
  covered: boolean
}

/**
 * Whether `use()` asks the server. A spend the offline allowance would refuse asks whatever the waits of an
 * outage (an allowance of 0 refuses every spend with no answer, and an online customer is not refused for an
 * outage that has passed), but for a wait of its own: not while a void opened less than a minute ago stands
 * (`voidWaiting`, by both clocks). A spend the allowance covers asks every time, except while a no-answer wait runs
 * (`backoffSince` set, `backoffMs` equal to RETRY_UNANSWERED_MS, and the device clock at or after it and before
 * its end: a clock set back asks at once) and while the journal's wait runs (`journalWaiting`). An answer of
 * any kind ends both waits.
 */
export function useAsksNow(ask: UseAsk): boolean {
  if (!ask.covered) return !voidWaiting(spendsOf(ask.state.spends), ask.now, ask.clockNow)
  const { backoffSince, backoffMs } = ask.state
  const waiting = backoffSince !== undefined && backoffMs === RETRY_UNANSWERED_MS && ask.clockNow >= backoffSince && ask.clockNow < backoffSince + backoffMs
  return !waiting && !journalWaiting(spendsOf(ask.state.spends), ask.now)
}

/** Whether the journal makes `status()` ask a valid lease's server now: it holds an entry and its wait is not running. */
export function journalAsks(spends: unknown, now: number): boolean {
  const journal = spendsOf(spends)
  return journal.length > 0 && !journalWaiting(journal, now)
}

// --- reports ---------------------------------------------------------------------------

/** The report a body carries: the journal's entries, oldest first, at most MAX_PENDING_SPENDS, a void marked; none for an empty journal. */
export function spendsReported(spends: readonly SpendEntry[]): SpendReport[] | undefined {
  const report = spends.slice(0, MAX_PENDING_SPENDS).map((e): SpendReport => ({ id: e.id, meter: e.meter, n: e.n, at: e.at, ...(e.kind === 'void' ? { void: true } : {}) }))
  return report.length > 0 ? report : undefined
}

/**
 * The reports an answer names as recorded (`spends`), read leniently: a member of another shape confirms
 * nothing. A void names itself; any other names how many it holds. No answer at all, a 5xx and a 429 confirm
 * nothing, whatever their body says.
 */
export function spendsConfirmed(response: { status: number; json: unknown } | null): Confirmed[] {
  if (response === null || noAnswer(response.status)) return []
  const listed = asObject(response.json)?.spends
  if (!Array.isArray(listed)) return []
  const confirmed: Confirmed[] = []
  for (const member of listed) {
    const m = asObject(member)
    if (m === null || typeof m.id !== 'string') continue
    if (m.void === true) confirmed.push({ id: m.id, void: true })
    else if (isWhole(m.n) && m.n >= 1) confirmed.push({ id: m.id, n: m.n })
  }
  return confirmed
}

// --- what an answer does ------------------------------------------------------------------

/** The figures a `use` answer gives, each stamped with the server's time (`at`); none for an answer without a whole `at`. */
function answeredFigures(body: Record<string, unknown> | null): Record<string, MeterFigure> {
  const at = body?.at
  if (body === null || !isFigure(at)) return {}
  return Object.fromEntries(Object.entries(metersOf(body.meters)).map(([code, m]) => [code, { ...m, at }]))
}

/** What a `use` answer is judged from. */
export interface UseResponse {
  /** The answer; null when there was none at all (the request threw or timed out). */
  response: { status: number; json: unknown } | null
  /** When the request was made, by the device clock (ms): where the wait before asking again starts. */
  askedAt: number
  /** This build's major, sent with the request. */
  major: number
  /** Who this device is, as the request read it. */
  device: Pick<Device, 'kind' | 'ownClaim'>
}

/** What a `use` answer does. */
export interface UseOutcome {
  /** `unanswered`: no usable answer, so the spend comes from the offline allowance, in doubt when it was sent. */
  outcome: 'spent' | 'used-up' | 'no-meter' | 'refused' | 'unanswered'
  /** The refusal, when the server's verdict was one. */
  refusal?: Refusal
  /** What the answer says is left, for `used-up`. */
  left?: number
  /** What is saved as the answer to the ask. */
  patch: Partial<StoredState>
  /** The figures saved (the newer by `at` is kept). */
  figures: Record<string, MeterFigure>
  /** The reports the answer confirms. */
  confirmed: Confirmed[]
}

/** An answer that saves and confirms nothing. */
const nothing = (): Pick<UseOutcome, 'patch' | 'figures' | 'confirmed'> => ({ patch: {}, figures: {}, confirmed: [] })

/**
 * What a `use` answer saves and says. No answer at all: the wait (RETRY_UNANSWERED_MS) and the device's kind.
 * A 5xx or a 429, and any answer that is neither a spend nor a recognised word: nothing, the offline path.
 * A 200 is a spend only with `spent: true`. On any other status, `used-up`, `unknown-meter` and a validate's
 * verdicts (`refusalOf`, stored as a validate's are) are read; each saves the reports it confirms, and a
 * verdict its refusal.
 */
export function useOutcome(input: UseResponse): UseOutcome {
  const { response, askedAt, major, device } = input
  const keyed = keyedBy(device)
  if (response === null) return { outcome: 'unanswered', ...nothing(), patch: { backoffSince: askedAt, backoffMs: RETRY_UNANSWERED_MS, ...keyed } }
  if (noAnswer(response.status)) return { outcome: 'unanswered', ...nothing() }
  const body = asObject(response.json)
  if (response.status === 200) {
    if (body?.spent !== true) return { outcome: 'unanswered', ...nothing() }
    return { outcome: 'spent', patch: {}, figures: answeredFigures(body), confirmed: spendsConfirmed(response) }
  }
  const error = errorOf(response.json)
  const confirmed = spendsConfirmed(response)
  const left = body?.left
  if (error === 'used-up') return { outcome: 'used-up', ...(isFigure(left) ? { left } : {}), patch: {}, figures: answeredFigures(body), confirmed }
  if (error === 'unknown-meter') return { outcome: 'no-meter', patch: {}, figures: {}, confirmed }
  const refused = refusalOf(error)
  if (refused === null) return { outcome: 'unanswered', ...nothing() }
  const patch = { checkedMajor: major, backoffSince: askedAt, backoffMs: ASK_AGAIN_MS, ...keyed, ...refusalPatch(refused, major, device) }
  return { outcome: 'refused', refusal: refused, patch, figures: {}, confirmed }
}
