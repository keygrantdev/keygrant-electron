/**
 * Spending a key's meters under `License` (license.ts), the SDK contract's section 12: `use(meter, n)` asks the
 * server when it should (exact, atomic, idempotent by the spend's id), and when it gets no answer spends from
 * the device's offline allowance, keeping the spend in the journal (journal.ts) to report with the next request.
 *
 * A meter never takes a licence away, and licensing fails in favour of the customer: no answer is never a
 * refusal of the licence, only of a spend past the allowance, and the journal never fails a renewal.
 */
import type { LeaseClaims } from '@keygrant/shared'
import type { Asked } from './offline.js'
import type { StoredState, UseResult } from './types.js'
import { FileEngine } from './files.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { landJournal, type JournalOp } from './journal.js'
import { USE_TIMEOUT_MS, askedFor, figuresFor, newSpendId, offlineSpend, spendsOf, spendsReported, unsyncedOf, useAsksNow, useOutcome, useRequestBody, type UseOutcome } from './meters.js'

/** One call to `use()`, as the steps below read it. */
interface Spending {
  /** The state the call read, with what this process could not save landed on it. */
  state: StoredState
  claims: LeaseClaims
  meter: string
  n: number
  /** The spend's id. */
  id: string
  /** When (the guarded clock) the spend is made. */
  at: number
  /** Behind a call that has not finished: nothing is saved. */
  readOnly: boolean
  /** What the offline allowance says of the spend as the call read the state (meters.ts `offlineSpend`). */
  verdict: ReturnType<typeof offlineSpend>
}

export abstract class MeterEngine extends FileEngine {
  /**
   * The claims of the key's lease when the state licenses this build here by a key's lease: what `status()`
   * would give as `licensed` from what is stored (no ask, no write), and not by a licence file. Null otherwise.
   */
  protected abstract keyClaims(state: StoredState): Promise<LeaseClaims | null>

  /**
   * Spend `n` of the meter `meter` (license.ts `use`). Never rejects: what cannot be told is `storage`.
   * Calls run one at a time with the rest (engine.ts `serial`).
   */
  protected async useMeter(meter: unknown, n: unknown): Promise<UseResult> {
    const asked = askedFor(meter, n)
    if ('refused' in asked) return { ok: false, error: asked.refused }
    try {
      return await this.serial((readOnly) => this.spend(asked.meter, asked.n, readOnly))
    } catch {
      // Nothing an adapter does may reject a spend: the customer is told to try again shortly.
      return { ok: false, error: 'storage' }
    }
  }

  /** The steps of a spend: the state and the licence, then the server when it should be asked, then the allowance. */
  private async spend(meter: string, n: number, readOnly: boolean): Promise<UseResult> {
    if (!readOnly) await this.saveUnsavedJournal()
    const state = await this.loadForStatus(readOnly)
    if (state === null) return { ok: false, error: 'storage' }
    const claims = await this.keyClaims(state)
    if (claims === null || state.activationId === undefined) return { ok: false, error: 'not-licensed' }
    const at = this.effectiveNow(state)
    const verdict = offlineSpend(figuresFor(claims, state), spendsOf(state.spends), meter, n)
    const spending: Spending = { state, claims, meter, n, id: newSpendId(), at, readOnly, verdict }
    let sent = false
    if (useAsksNow({ state, clockNow: this.a.clock.now(), now: at, covered: verdict.ok })) {
      const online = await this.askToSpend(spending)
      if ('result' in online) return online.result
      sent = true
    }
    return this.spendOffline(spending, sent)
  }

  /**
   * Ask the server to spend (`use`, bounded by USE_TIMEOUT_MS or the HTTP bound when shorter), with the
   * journal's report. Its answer is saved as a validate's is (meters.ts `useOutcome`) unless this call is
   * behind one that has not finished; with no usable answer the spend is in doubt: the server may hold it.
   */
  private async askToSpend(sp: Spending): Promise<{ result: UseResult } | { doubt: true }> {
    const { state } = sp
    const askedAt = this.a.clock.now()
    const asked: Asked = { at: sp.at, activationId: state.activationId, seen: state.verdictAt }
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
    // Outside the request's try: a key set that cannot be imported is the app's configuration.
    const kids = await this.keyIds()
    const reports = spendsReported(await this.reportable(state))
    const body = useRequestBody(this.deviceBody(state, device), sp, reports, kids)
    let response: { status: number; json: unknown } | null
    try {
      response = await this.post('use', body, this.boundedBy(USE_TIMEOUT_MS))
    } catch {
      response = null
    }
    const outcome = useOutcome({ response, askedAt, major: this.major, device })
    const ops = journalOps(state, outcome)
    // A verdict or a wait is the answer to an ask, stamped as a validate's is; figures and confirmations are not
    // a verdict, so a spend never makes a validate another process asked for earlier look out of date.
    const answer = Object.keys(outcome.patch).length > 0 ? { answer: asked } : undefined
    if (!sp.readOnly && (ops.length > 0 || answer !== undefined)) await this.saveOps(state, outcome.patch, answer, ops)
    if (outcome.outcome === 'unanswered') return { doubt: true }
    return { result: answered(outcome, sp, landJournal(state, ops, sp.at).state) }
  }

  /**
   * With no answer (or none asked): spend from the allowance (meters.ts `offlineSpend`). Allowed, the spend is
   * journaled, `offline` when it was never sent and `unanswered` when it was in doubt, with the most the meter's
   * unsynced spends may come to (`limit`), which the landing judges again on the state as stored then, so two
   * processes never pass the allowance together. Refused, a spend in doubt is journaled as a `void`, for the
   * server to take it back off if it recorded it, and so is one the landing refuses (the journal full, or the
   * allowance taken by another process meanwhile, answered with what is left as the landing found it): the
   * customer is told `offline-limit`, the server is told the spend is taken back. Voids are kept to
   * MAX_PENDING_VOIDS, a new one taking the place of the oldest, and a void a full journal cannot take is lost.
   */
  private async spendOffline(sp: Spending, doubt: boolean): Promise<UseResult> {
    const { state, meter, n, verdict } = sp
    const about = state.activationId as string
    const entry = { about, id: sp.id, meter, n, at: sp.at }
    if (!verdict.ok) {
      if (doubt) await this.journal(sp, [{ kind: 'void', ...entry }])
      return verdict.error === 'no-meter' ? { ok: false, error: 'no-meter' } : { ok: false, error: 'offline-limit', left: verdict.left }
    }
    const [refused] = await this.journal(sp, [{ kind: doubt ? 'unanswered' : 'offline', ...entry, limit: verdict.limit }])
    if (refused) {
      if (doubt) await this.journal(sp, [{ kind: 'void', ...entry }])
      return { ok: false, error: 'offline-limit', left: await this.landedLeft(sp) }
    }
    return { ok: true, left: verdict.left, offline: true }
  }

  /**
   * What is left of the meter by the state as a refused landing found it (another process had spent meanwhile):
   * the figure less the unsynced spends there then, never below 0, and 0 when the state cannot be read just now.
   */
  private async landedLeft(sp: Spending): Promise<number> {
    const fresh = await this.loadForStatus(sp.readOnly)
    if (fresh === null) return 0
    const figure = figuresFor(sp.claims, fresh)[sp.meter]
    return figure === undefined ? 0 : Math.max(0, figure.left - unsyncedOf(spendsOf(fresh.spends), sp.meter))
  }

  /** `ops` saved, or kept in memory when this call may save nothing or the disk refuses. Whether each was refused. */
  private journal(sp: Spending, ops: JournalOp[]): Promise<boolean[]> {
    return sp.readOnly ? Promise.resolve(this.keepUnsaved(sp.state, ops)) : this.saveOps(sp.state, {}, undefined, ops)
  }
}

/** The journal changes an answer makes: the reports it confirms and the figures it gives, about the activation asked for. */
function journalOps(state: StoredState, outcome: UseOutcome): JournalOp[] {
  const about = state.activationId
  if (about === undefined) return []
  return [
    ...(outcome.confirmed.length > 0 ? [{ kind: 'confirmed' as const, about, entries: outcome.confirmed }] : []),
    ...(Object.keys(outcome.figures).length > 0 ? [{ kind: 'figures' as const, about, figures: outcome.figures }] : []),
  ]
}

/**
 * What `use()` answers for an answer the server gave. A spend: what is left of the meter by the figures as
 * the answer left them (`after`: the base figure, its own from the answer when it gave one, less what this
 * device has not reported). `used-up`: the answer's `left`. A verdict: the refusal, as `status()` will say it.
 */
function answered(outcome: UseOutcome, sp: Spending, after: StoredState): UseResult {
  switch (outcome.outcome) {
    case 'spent': {
      const figure = figuresFor(sp.claims, after)[sp.meter]
      return { ok: true, left: figure === undefined ? 0 : Math.max(0, figure.left - unsyncedOf(spendsOf(after.spends), sp.meter)) }
    }
    case 'used-up':
      return { ok: false, error: 'used-up', ...(outcome.left !== undefined ? { left: outcome.left } : {}) }
    case 'no-meter':
      return { ok: false, error: 'no-meter' }
    default:
      return { ok: false, error: outcome.refusal ?? 'not-licensed' }
  }
}
