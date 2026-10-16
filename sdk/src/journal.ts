/**
 * How the journal of unsynced spends (`StoredState.spends`) and the figures beside it (`meterFigures`) land on
 * the stored state (the SDK contract, 12.4): on the state as stored at that moment, as merge.ts `merged` lands
 * the rest, so that two processes of one app never lose each other's spends. Both fields are about the stored
 * activation: a save made for another activation, or on a state with none, writes neither.
 */
import type { Confirmed, MeterFigure, SpendEntry } from './meter-types.js'
import type { StoredState } from './types.js'
import { MAX_PENDING_SPENDS, MAX_PENDING_VOIDS, PENDING_MAX_MS, spendsOf, storedFigures, unsyncedOf } from './meters.js'

/** One change to the journal or its figures, about the activation `about`. */
export type JournalOp =
  /**
   * A spend made with no request sent (`offline`), or whose own request got no answer (`unanswered`), or one
   * refused after that (`void`). A spend carries the most its meter's unsynced spends may come to with it
   * (`limit`, the smaller of the device's allowance and what is left), judged again where it lands. `told`:
   * the customer was told the spend was made while a failed save kept it in memory, so it lands whatever the
   * limit and the cap say: a spend is never taken back. Not read on a void, which is the take-back of a spend
   * the customer was refused, never one told: a void is always held to the void cap and to the journal's.
   */
  | { kind: 'offline' | 'unanswered' | 'void'; about: string; id: string; meter: string; n: number; at: number; limit?: number; told?: true }
  /** An answer's `spends`: the entries the server recorded. */
  | { kind: 'confirmed'; about: string; entries: Confirmed[] }
  /** The figures a `use` answer gave, by code. */
  | { kind: 'figures'; about: string; figures: Record<string, MeterFigure> }
  /** An activation, saved: another seat's journal is dropped, the same seat's is kept. */
  | { kind: 'activated'; about: string }
  /** A deactivation: the journal goes with the rest of the licence. */
  | { kind: 'deactivated' }

/** The ops that open or grow an entry of the journal. */
export type AppendOp = Extract<JournalOp, { meter: string }>

/** What the journal lands on: the activation stored, and the two fields. */
export type JournalState = Pick<StoredState, 'activationId' | 'spends' | 'meterFigures'>

/** The fields after an op; `refused` is true when it was a spend the full journal could not take, or its limit forbids. */
export interface Journaled {
  spends: SpendEntry[]
  meterFigures: Record<string, MeterFigure>
  refused: boolean
}

/** Whether an answer's confirmation names a stored entry as recorded. A void is named by `void`, any other by how many the server holds. */
function confirms(entry: SpendEntry, confirmed: readonly Confirmed[]): boolean {
  return confirmed.some((c) => c.id === entry.id && ('void' in c ? entry.kind === 'void' : entry.kind !== 'void' && entry.n <= c.n))
}

/** `figures` with the incoming ones, for each meter the newer by `at` kept. */
function newest(stored: Record<string, MeterFigure>, incoming: Record<string, MeterFigure>): Record<string, MeterFigure> {
  const merged = new Map(Object.entries(stored))
  for (const [code, figure] of Object.entries(incoming)) {
    const held = merged.get(code)
    if (held === undefined || figure.at > held.at) merged.set(code, figure)
  }
  return Object.fromEntries(merged)
}

/** The void a new void takes the place of: the oldest, when the journal already holds MAX_PENDING_VOIDS. */
function voidToReplace(journal: SpendEntry[]): SpendEntry | undefined {
  const voids = journal.filter((e) => e.kind === 'void')
  return voids.length >= MAX_PENDING_VOIDS ? voids[0] : undefined
}

/** Whether a spend was told to the customer: so it lands whatever the limit and the cap say. A void never is. */
const toldOf = (op: AppendOp): boolean => op.kind !== 'void' && op.told === true

/**
 * The journal an entry is opened in: for a void, without the oldest void when MAX_PENDING_VOIDS are held (the new
 * one takes its place), so the attempts of a device out of reach never fill the journal the spends it can make
 * need. Whether it has room: a new entry past the cap is refused, unless it was told.
 */
function opened(journal: SpendEntry[], op: AppendOp): { spends: SpendEntry[]; refused: boolean } {
  const oldest = op.kind === 'void' ? voidToReplace(journal) : undefined
  const room = oldest === undefined ? journal : journal.filter((e) => e !== oldest)
  if (room.length >= MAX_PENDING_SPENDS && !toldOf(op)) return { spends: journal, refused: true }
  return { spends: [...room, { id: op.id, meter: op.meter, n: op.n, at: op.at, kind: op.kind }], refused: false }
}

/**
 * The journal with an append applied: an `offline` entry grows or is opened, the others are opened once by id;
 * none that would take the meter's unsynced spends past the op's `limit` (a void is no spend, and a told one
 * lands whatever it says), nor a new entry past the cap (`opened`). An `offline` spend that joins an entry loses
 * its id, which is why no request reports a spend still held in memory (engine.ts `reportable`).
 */
function appended(journal: SpendEntry[], op: AppendOp): { spends: SpendEntry[]; refused: boolean } {
  // A spend whose id the journal holds is the one it is: left as it is, whatever the limit now says.
  if (op.kind !== 'offline' && journal.some((e) => e.id === op.id)) return { spends: journal, refused: false }
  const limit = op.kind !== 'void' && !toldOf(op) ? op.limit : undefined
  if (limit !== undefined && unsyncedOf(journal, op.meter) + op.n > limit) return { spends: journal, refused: true }
  const open = op.kind === 'offline' ? journal.findIndex((e) => e.kind === 'offline' && e.meter === op.meter) : -1
  if (open >= 0) return { spends: journal.map((e, i) => (i === open ? { ...e, n: e.n + op.n } : e)), refused: false }
  return opened(journal, op)
}

/**
 * The journal and the figures after `op`, landed on `latest` at `now` (the guarded clock). An op about another
 * activation than the one stored, or about none, changes nothing; a deactivation clears both, and an activation
 * of another seat does (the same seat activated again keeps them). Every op that lands drops the entries opened
 * more than PENDING_MAX_MS before `now`, unreported. An append the journal has no room for is `refused`.
 */
export function journaled(latest: JournalState, op: JournalOp, now: number): Journaled {
  const spends = spendsOf(latest.spends)
  const meterFigures = storedFigures(latest.meterFigures)
  if (op.kind === 'deactivated') return { spends: [], meterFigures: {}, refused: false }
  if (latest.activationId === undefined || latest.activationId !== op.about) {
    return op.kind === 'activated' ? { spends: [], meterFigures: {}, refused: false } : { spends, meterFigures, refused: false }
  }
  const live = spends.filter((e) => now - e.at <= PENDING_MAX_MS)
  switch (op.kind) {
    case 'activated':
      return { spends: live, meterFigures, refused: false }
    case 'confirmed':
      return { spends: live.filter((e) => !confirms(e, op.entries)), meterFigures, refused: false }
    case 'figures':
      return { spends: live, meterFigures: newest(meterFigures, op.figures), refused: false }
    default: {
      const landed = appended(live, op)
      return { spends: landed.spends, meterFigures, refused: landed.refused }
    }
  }
}

/** Confirmations with each id once as a count and once as a void, the larger count kept: the entries any of them would have dropped. */
function foldedConfirmations(entries: readonly Confirmed[]): Confirmed[] {
  const folded = new Map<string, Confirmed>()
  for (const c of entries) {
    const key = `${'void' in c ? 'void' : 'count'} ${c.id}`
    const held = folded.get(key)
    if (held === undefined || ('n' in c && 'n' in held && c.n > held.n)) folded.set(key, c)
  }
  return [...folded.values()]
}

/**
 * `ops` with neighbours folded together where landing them one after the other lands what landing the
 * fold does: offline spends of one meter (their counts added, the first's id and time kept), figures (the
 * newer of each meter) and confirmations (each id once, the larger count). A disk that keeps refusing
 * the journal then costs the process a short list, however many spends it holds.
 */
export function compacted(ops: readonly JournalOp[]): JournalOp[] {
  const out: JournalOp[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (last?.kind === 'offline' && op.kind === 'offline' && last.about === op.about && last.meter === op.meter) {
      out[out.length - 1] = { ...last, n: last.n + op.n }
    } else if (last?.kind === 'figures' && op.kind === 'figures' && last.about === op.about) {
      out[out.length - 1] = { ...last, figures: newest(last.figures, op.figures) }
    } else if (last?.kind === 'confirmed' && op.kind === 'confirmed' && last.about === op.about) {
      out[out.length - 1] = { ...last, entries: foldedConfirmations([...last.entries, ...op.entries]) }
    } else {
      out.push(op)
    }
  }
  return out
}

/** `ops` with all but the newest MAX_PENDING_VOIDS void ops dropped: a process that cannot save keeps no more voids than the journal would. */
export function boundedVoids(ops: readonly JournalOp[]): JournalOp[] {
  const voids = ops.filter((op) => op.kind === 'void')
  const dropped = new Set(voids.slice(0, Math.max(0, voids.length - MAX_PENDING_VOIDS)))
  return ops.filter((op) => !dropped.has(op))
}

/** A state with the journal fields `j` gives: an empty journal or no figures is the field absent. */
function withJournal(state: StoredState, j: Journaled): StoredState {
  const { spends: _spends, meterFigures: _figures, ...rest } = state
  return { ...rest, ...(j.spends.length > 0 ? { spends: j.spends } : {}), ...(Object.keys(j.meterFigures).length > 0 ? { meterFigures: j.meterFigures } : {}) }
}

/** `ops` landed in order on `state` at `now`, and whether each was refused; the state itself when there are none. */
export function landJournal(state: StoredState, ops: readonly JournalOp[], now: number): { state: StoredState; refused: boolean[] } {
  let current = state
  const refused: boolean[] = []
  for (const op of ops) {
    const landed = journaled(current, op, now)
    refused.push(landed.refused)
    current = withJournal(current, landed)
  }
  return { state: current, refused }
}
