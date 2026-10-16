/**
 * The `journals` group (the SDK contract, 12.4): each change to the journal of unsynced spends and the
 * figures beside it, landed on the state as stored (`journaled`).
 */
import type { AppendOp, JournalOp, JournalState } from '../../src/journal.js'
import { MAX_PENDING_SPENDS, MAX_PENDING_VOIDS, PENDING_MAX_MS } from '../../src/meters.js'
import type { MeterFigure, SpendEntry } from '../../src/meter-types.js'
import type { GroupInputs } from '../inputs.js'
import { NOW } from './common.js'
import { spend, stored } from './meters.js'

const A = 'act_1'
const id = (c: string) => c.repeat(22)

/** `count` voids, the first the oldest. */
const voids = (count: number): SpendEntry[] => Array.from({ length: count }, (_, i) => spend('void', 1, { id: String(i).padStart(22, 'v'), at: NOW - 200_000 + i }))

/** `count` unanswered entries of distinct meters, opened a little before now. */
const crowd = (count: number): SpendEntry[] => Array.from({ length: count }, (_, i) => spend('unanswered', 1, { id: String(i).padStart(22, 'k'), meter: `m${i}`, at: NOW - 100_000 + i }))

export function journals(): GroupInputs['journals'][] {
  const at = NOW
  const c = (name: string, latest: JournalState, op: JournalOp, now = NOW): GroupInputs['journals'] => ({ name, latest, op, now })
  const held = (spends: SpendEntry[], extra: Partial<JournalState> = {}): JournalState => ({ activationId: A, spends, ...extra })
  const append = (kind: AppendOp['kind'], letter: string) => (n: number, over: Partial<Omit<AppendOp, 'kind'>> = {}): JournalOp => ({ kind, about: A, id: id(letter), meter: 'exports', n, at, ...over })
  const offline = append('offline', 'N')
  const unanswered = append('unanswered', 'U')
  const voided = append('void', 'V')
  const confirmed = (entries: Extract<JournalOp, { kind: 'confirmed' }>['entries'], about = A): JournalOp => ({ kind: 'confirmed', about, entries })
  const figures = (f: Record<string, MeterFigure>, about = A): JournalOp => ({ kind: 'figures', about, figures: f })
  const day = 86_400_000
  const on = (spends: SpendEntry[]) => held(spends)
  const unanswered1 = spend('unanswered', 3, { id: id('A') })
  const offline1 = spend('offline', 3, { id: id('B') })
  const void1 = spend('void', 2, { id: id('C') })
  const figure = stored(50, 100, 10, NOW - 1000)
  return [
    // Offline spends grow one entry for each meter.
    c('an offline spend opens an entry', held([]), offline(2)),
    c('an offline spend opens an entry on a state with no journal', { activationId: A }, offline(2)),
    c('an offline spend grows the meter’s entry, which keeps its id and time', on([offline1]), offline(2, { id: id('X'), at: NOW + 5 })),
    c('an offline spend opens the entry of another meter', on([offline1]), offline(2, { meter: 'renders' })),
    c('an offline spend grows the entry of its own meter, among others', on([spend('offline', 4, { id: id('D'), meter: 'renders' }), offline1]), offline(1)),
    c('an offline spend does not grow an unanswered entry of its meter: it opens its own', on([unanswered1]), offline(2)),
    c('an offline spend does not grow a void of its meter: it opens its own', on([void1]), offline(2)),
    c('an offline spend opens the 64th entry', on(crowd(MAX_PENDING_SPENDS - 1)), offline(1)),
    c('an offline spend finds no room for a 65th entry: refused', on(crowd(MAX_PENDING_SPENDS)), offline(1)),
    c('an offline spend grows an open entry though the journal is full', on([offline1, ...crowd(MAX_PENDING_SPENDS - 1)]), offline(4)),
    // Unanswered spends and voids are opened once, by id.
    c('an unanswered spend opens an entry of its own', held([]), unanswered(1)),
    c('an unanswered spend beside an offline entry of its meter', on([offline1]), unanswered(1)),
    c('an unanswered spend whose id is held is left as it is', on([unanswered1]), unanswered(5, { id: id('A') })),
    c('an unanswered spend whose id an offline entry holds is left as it is', on([offline1]), unanswered(5, { id: id('B') })),
    c('an unanswered spend finds no room: refused', on(crowd(MAX_PENDING_SPENDS)), unanswered(1)),
    c('a void opens an entry of its own', held([]), voided(2)),
    c('a void whose id is held is left as it is', on([void1]), voided(9, { id: id('C') })),
    c('a void beside the unanswered entry of another spend', on([unanswered1]), voided(1)),
    c('a void finds no room: lost', on(crowd(MAX_PENDING_SPENDS)), voided(1)),
    // An op is about an activation.
    c('an offline spend about another activation changes nothing', on([offline1]), offline(2, { about: 'act_2' })),
    c('an unanswered spend on a state with no activation changes nothing', { spends: [offline1] }, unanswered(2)),
    c('a confirmation about another activation changes nothing', on([unanswered1]), confirmed([{ id: id('A'), n: 3 }], 'act_2')),
    c('figures about another activation change nothing', on([offline1]), figures({ exports: figure }, 'act_2')),
    // A confirmation drops what the server recorded.
    c('a confirmation drops the entry it names, by its count', on([unanswered1, offline1]), confirmed([{ id: id('A'), n: 3 }])),
    c('a confirmation of more than the entry holds drops it', on([unanswered1]), confirmed([{ id: id('A'), n: 9 }])),
    c('a confirmation of less than an offline entry holds keeps it with its count', on([offline1]), confirmed([{ id: id('B'), n: 2 }])),
    c('a confirmation of less than an unanswered entry holds keeps it', on([unanswered1]), confirmed([{ id: id('A'), n: 2 }])),
    c('a confirmation of an offline entry that grew meanwhile keeps the growth', on([spend('offline', 5, { id: id('B') })]), confirmed([{ id: id('B'), n: 3 }])),
    c('a void is dropped by a void', on([void1]), confirmed([{ id: id('C'), void: true }])),
    c('a count does not drop a void', on([void1]), confirmed([{ id: id('C'), n: 2 }])),
    c('a void does not drop an unanswered entry', on([unanswered1]), confirmed([{ id: id('A'), void: true }])),
    c('a confirmation of an id the journal does not hold changes nothing', on([unanswered1]), confirmed([{ id: id('Z'), n: 3 }])),
    c('several confirmations at once', on([unanswered1, offline1, void1]), confirmed([{ id: id('A'), n: 3 }, { id: id('C'), void: true }])),
    c('no confirmation drops nothing', on([unanswered1]), confirmed([])),
    // Figures: the newer by time is kept.
    c('a figure for a meter with none is stored', held([]), figures({ exports: figure })),
    c('a newer figure replaces the stored one', held([], { meterFigures: { exports: stored(70, 100, 10, NOW - 5000) } }), figures({ exports: figure })),
    c('an older figure is kept out', held([], { meterFigures: { exports: stored(70, 100, 10, NOW + 5000) } }), figures({ exports: figure })),
    c('a figure of the same time keeps the stored one', held([], { meterFigures: { exports: stored(70, 100, 10, NOW - 1000) } }), figures({ exports: figure })),
    c('figures for several meters: the newer of each', held([], { meterFigures: { exports: stored(70, 100, 10, NOW + 5000), renders: stored(1, 5, 0, NOW - 5000, true) } }), figures({ exports: figure, renders: stored(4, 5, 0, NOW - 1000, true) })),
    c('a figure beside a journal leaves it as it is', on([offline1]), figures({ exports: figure })),
    // A seat's journal belongs to the seat.
    c('activating another seat drops the journal and the figures', held([offline1], { meterFigures: { exports: figure } }), { kind: 'activated', about: 'act_2' }),
    c('activating the same seat again keeps them', held([offline1], { meterFigures: { exports: figure } }), { kind: 'activated', about: A }),
    c('activating on a state with no activation leaves nothing', { spends: [offline1] }, { kind: 'activated', about: A }),
    c('a deactivation clears them', held([offline1], { meterFigures: { exports: figure } }), { kind: 'deactivated' }),
    c('a deactivation of a state with no activation clears them too', { spends: [offline1], meterFigures: { exports: figure } }, { kind: 'deactivated' }),
    // Entries unreported for more than 180 days are dropped, whatever lands.
    c('an entry opened exactly 180 days ago is kept', on([spend('unanswered', 1, { id: id('A'), at: NOW - PENDING_MAX_MS })]), offline(1)),
    c('an entry opened 180 days and a millisecond ago is dropped', on([spend('unanswered', 1, { id: id('A'), at: NOW - PENDING_MAX_MS - 1 })]), offline(1)),
    c('the old are dropped and the recent kept', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day }), offline1]), unanswered(1)),
    c('the horizon is applied when a confirmation lands', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day }), spend('unanswered', 1, { id: id('E'), at: NOW - day })]), confirmed([{ id: id('E'), n: 9 }])),
    c('the horizon is applied when figures land', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day })]), figures({ exports: figure })),
    c('the horizon is applied when an activation is saved again', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day })]), { kind: 'activated', about: A }),
    c('an old entry makes room for an append at the cap', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day }), ...crowd(MAX_PENDING_SPENDS - 1)]), offline(1)),
    c('the horizon is not applied to a state the op is not about', on([spend('unanswered', 1, { id: id('A'), at: NOW - 200 * day })]), offline(1, { about: 'act_2' })),
    c('an old offline entry is dropped, not grown', on([spend('offline', 4, { id: id('B'), at: NOW - 200 * day })]), offline(1)),
    // The most a meter's unsynced spends may come to with a spend is judged where it lands, on the journal as stored then.
    c('an offline spend that brings the unsynced to its limit grows the entry', on([offline1]), offline(7, { limit: 10 })),
    c('an offline spend one past its limit is refused', on([offline1]), offline(8, { limit: 10 })),
    c('an offline spend that opens an entry past its limit is refused', held([]), offline(11, { limit: 10 })),
    c('an unanswered spend at its limit opens an entry', on([offline1]), unanswered(7, { limit: 10 })),
    c('an unanswered spend past its limit is refused', on([offline1]), unanswered(8, { limit: 10 })),
    c('the limit counts both kinds of the meter, no void and no other meter: at it', on([offline1, spend('unanswered', 2, { id: id('D') }), spend('void', 50, { id: id('C') }), spend('offline', 9, { id: id('E'), meter: 'renders' })]), offline(5, { limit: 10 })),
    c('the limit counts both kinds of the meter, no void and no other meter: one past it', on([offline1, spend('unanswered', 2, { id: id('D') }), spend('void', 50, { id: id('C') }), spend('offline', 9, { id: id('E'), meter: 'renders' })]), offline(6, { limit: 10 })),
    c('a limit of 0 refuses every spend', held([]), offline(1, { limit: 0 })),
    c('a void is not held to a limit', held([]), voided(5, { limit: 0 })),
    c('an unanswered spend whose id is held is left as it is, though its limit is passed', on([unanswered1]), unanswered(9, { id: id('A'), limit: 1 })),
    // A spend the customer was told was made lands whatever the limit and the cap say: a spend is never taken back.
    c('a told offline spend lands past its limit', on([offline1]), offline(9, { limit: 5, told: true })),
    c('a told unanswered spend lands past its limit', on([offline1]), unanswered(9, { limit: 5, told: true })),
    c('a told spend opens an entry past the cap', on(crowd(MAX_PENDING_SPENDS)), offline(1, { told: true })),
    c('a void marked told is held to the cap as any void: refused in a full journal', on(crowd(MAX_PENDING_SPENDS)), voided(1, { told: true })),
    // Voids are kept to MAX_PENDING_VOIDS: the next takes the place of the oldest, and the journal keeps its room for spends.
    c('a void opens the last of the voids it may hold', on(voids(MAX_PENDING_VOIDS - 1)), voided(1)),
    c('a void past the voids it may hold takes the place of the oldest', on(voids(MAX_PENDING_VOIDS)), voided(1)),
    c('a void past the voids it may hold takes the place of the oldest, in a journal that is full', on([...voids(MAX_PENDING_VOIDS), ...crowd(MAX_PENDING_SPENDS - MAX_PENDING_VOIDS)]), voided(1)),
    c('a void is refused when the journal is full and holds fewer voids than it may', on([...voids(MAX_PENDING_VOIDS - 1), ...crowd(MAX_PENDING_SPENDS - MAX_PENDING_VOIDS + 1)]), voided(1)),
    c('a void marked told takes the place of the oldest void as any void', on(voids(MAX_PENDING_VOIDS)), voided(1, { told: true })),
    c('an unanswered spend is not held to the voids it may hold', on(voids(MAX_PENDING_VOIDS)), unanswered(1, { limit: 10 })),
    c('a void whose id is held among the voids it may hold is left as it is', on(voids(MAX_PENDING_VOIDS)), voided(1, { id: String(3).padStart(22, 'v') })),
  ]
}
