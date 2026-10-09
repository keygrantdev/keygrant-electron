/**
 * How a save lands on the state as stored at that moment (`merged`): what it is
 * based on (an answer to an ask, an activation, a note about an activation, a
 * trial answer), and which of its fields an answer already out of date, or one
 * about an activation no longer stored, may still write. Named from offline.ts
 * too, where the SDK's other offline decisions are.
 */
import type { StoredState } from './types.js'
import { earliest } from './wire.js'

/**
 * When something was asked of the server (guarded device clock, ms), and the
 * stored stamp of that kind the asker saw.
 */
export interface Stamp {
  at: number
  seen?: number
}

/** An ask of the server about an activation, as a save of its answer sees it (engine.ts `save`). */
export interface Asked extends Stamp {
  /** The activation it asked about. */
  activationId?: string
}

/** What a save is based on (engine.ts `save`, `merged`). */
export interface Basis {
  /** The answer to an ask about an activation: stamped `verdictAt`. */
  answer?: Asked
  /**
   * An activation's answer, about the activation it names (`activationId`):
   * stamped `verdictAt`. It lands whole on another activation (it replaces
   * it); on the same one (the seat activated again) it is an answer like any.
   */
  activation?: Asked
  /** A save about an activation that is not an answer (what a check-in noted it ran). */
  about?: { activationId?: string }
  /** The server's answer to a trial ask: stamped `trialAt`. */
  trial?: Stamp
  /**
   * A save about a purchase secret (`token`: its drop, or the wait after a
   * claim ask): its purchase fields (PURCHASE_FIELDS) land only while that
   * secret is the one stored, so one another process made meanwhile is
   * neither dropped nor stamped by it. A wait carries the `purchaseTokenAt`
   * its asker read (`at`), and lands only while that is stored too: a link
   * handed out again since (another process's `purchaseUrl`) cleared the wait
   * so that the next `status()` asks at once, and a late answer must not
   * start it again. A drop carries none: a spent secret is dead however
   * recently its link was handed out.
   */
  purchase?: { token: string; at?: number }
}

/** What the answer to an ask writes: what the server said, and the wait before asking again. */
const VERDICT_FIELDS = [
  'lease',
  'refused',
  'refusedMajor',
  'refusedFor',
  'backoffSince',
  'backoffMs',
  'checkedMajor',
  'verdictAt',
] as const

/** A server trial answer, taken whole from the newest one (`trialAt`): the end and the lease that says it. */
const TRIAL_ANSWER_FIELDS = ['trialEndsAt', 'trialLease', 'trialAt'] as const

/** The purchase token and its stamps, which a save about a token writes only while it is stored (`Basis.purchase`). */
const PURCHASE_FIELDS = ['purchaseToken', 'purchaseTokenAt', 'claimAskedAt'] as const

/** The trial evidence, which belongs to the device, not to any activation. */
const TRIAL_FIELDS = ['trialStart', ...TRIAL_ANSWER_FIELDS] as const

/**
 * Whether a stored stamp is a NEWER answer than `stamp`'s: saved since that
 * asker read the state (another stamp than the one it `seen`), and asked for
 * later than it. That is another process on this device (two app instances,
 * the one asked first answered last). Times are compared only then, so a
 * clock put back never stops one process saving its own answers.
 */
export function outdated(stored: number | undefined, stamp: Stamp): boolean {
  return stored !== stamp.seen && (stored ?? Number.NEGATIVE_INFINITY) > stamp.at
}

/**
 * Whether an ask's answer is out of date by the time it is saved: `activation`
 * when the state now names another activation, or none (activated or
 * deactivated meanwhile), and nothing of the answer but trial evidence may
 * land on it; `answer` when a newer answer about the same activation has been
 * saved (`outdated`), and its verdict fields (VERDICT_FIELDS) may not.
 */
export function superseded(latest: StoredState, asked: Asked): 'activation' | 'answer' | null {
  if (latest.activationId !== asked.activationId) return 'activation'
  return outdated(latest.verdictAt, asked) ? 'answer' : null
}

/** `patch` without `fields`. */
function omit(patch: Partial<StoredState>, fields: readonly (keyof StoredState)[]): Partial<StoredState> {
  const rest: Partial<StoredState> = { ...patch }
  for (const field of fields) delete rest[field]
  return rest
}

/** A patch without the verdict fields (VERDICT_FIELDS): what of an out-of-date answer is still saved. */
export function withoutVerdict(patch: Partial<StoredState>): Partial<StoredState> {
  return omit(patch, VERDICT_FIELDS)
}

/** Only the trial evidence of a patch (TRIAL_FIELDS): what lands on another activation. */
export function trialOnly(patch: Partial<StoredState>): Partial<StoredState> {
  const kept: Partial<StoredState> = {}
  for (const field of TRIAL_FIELDS) if (field in patch) Object.assign(kept, { [field]: patch[field] })
  return kept
}

/** Whether a save about a purchase secret is about the one stored, as handed out when its asker read it (`Basis.purchase`). */
function aboutStored(latest: StoredState, purchase: { token: string; at?: number }): boolean {
  if (latest.purchaseToken !== purchase.token) return false
  return purchase.at === undefined || latest.purchaseTokenAt === purchase.at
}

/** How out of date a save is by what it is based on (`merged`): see `superseded`. */
function outOfDate(latest: StoredState, basis: Basis): 'activation' | 'answer' | null {
  if (basis.answer) return superseded(latest, basis.answer)
  // An activation's answer on the same seat, activated again: an answer like
  // any, so a refusal another process asked for later is not undone by it.
  if (basis.activation) {
    const same = latest.activationId === basis.activation.activationId
    return same && outdated(latest.verdictAt, basis.activation) ? 'answer' : null
  }
  if (basis.about && latest.activationId !== basis.about.activationId) return 'activation'
  return null
}

/**
 * A patch merged onto the state as stored now, by what it is based on
 * (`basis`). Stamped: an answer or an activation with `verdictAt`, a trial
 * answer with `trialAt`. A save about an activation no longer stored keeps only
 * its trial evidence (`superseded` 'activation': install memory or a kept major
 * of the old activation never lands on the new state); an answer older than the
 * stored one loses its verdict fields, as does an activation of the same seat;
 * a trial answer older than the stored one loses its end and lease, taken
 * together from the newest (min-merging the end would refuse a trial the server
 * extended); a save about a purchase secret no longer stored (or, for a wait,
 * one handed out again since) loses its purchase fields. The trial start only
 * ever moves earlier, whoever saved it; the kept major of the stored activation
 * only ever up, whoever noted it (a deactivation, based on nothing, still
 * clears it).
 */
export function merged(latest: StoredState, patch: Partial<StoredState>, basis: Basis = {}): StoredState {
  const stamp = basis.answer ?? basis.activation
  let applied: Partial<StoredState> = {
    ...patch,
    ...(stamp ? { verdictAt: stamp.at } : {}),
    ...(basis.trial ? { trialAt: basis.trial.at } : {}),
  }
  const state = outOfDate(latest, basis)
  if (state === 'activation') applied = trialOnly(applied)
  if (state === 'answer') applied = withoutVerdict(applied)
  if (basis.trial && outdated(latest.trialAt, basis.trial)) applied = omit(applied, TRIAL_ANSWER_FIELDS)
  if (basis.purchase && !aboutStored(latest, basis.purchase)) applied = omit(applied, PURCHASE_FIELDS)
  const trialStart = earliest(latest.trialStart, applied.trialStart)
  const result: StoredState = { ...latest, ...applied, ...(trialStart !== undefined ? { trialStart } : {}) }
  return keptHighest(result, latest, applied, stamp ?? basis.about)
}

/**
 * `result` with the kept major a merge leaves: about the stored activation
 * (`about`), it only goes up, a renewal's none included; unbased (a
 * deactivation) or about another activation (a fresh one), as patched.
 */
function keptHighest(
  result: StoredState,
  latest: StoredState,
  applied: Partial<StoredState>,
  about: { activationId?: string } | undefined,
): StoredState {
  if (about === undefined || latest.activationId !== about.activationId) return result
  const kept = [latest.keptMajor, applied.keptMajor].filter((major): major is number => major !== undefined)
  return kept.length > 0 ? { ...result, keptMajor: Math.max(...kept) } : result
}
