/**
 * The metered-uses groups about what the server answers (the SDK contract, 12.2 and 12.6): what a
 * `use` answer does (`useOutcomes`), the reports an answer names as recorded (`spendConfirmations`)
 * and the report a request carries (`spendReports`).
 */
import { MAX_PENDING_SPENDS } from '../../src/meters.js'
import type { SpendEntry } from '../../src/meter-types.js'
import type { DeviceView, GroupInputs } from '../inputs.js'
import { NOW, clean, type Context } from './common.js'
import { spend } from './meters.js'

const id = (c: string) => c.repeat(22)

/** The figures a `use` answer gives, as the server writes them. */
const METERS = { exports: { left: 89, total: 100, offline: 10 }, renders: { left: 5, total: 5, offline: 0, resets: true } }

type Response = { status: number; json: unknown } | null

export function useOutcomes(ctx: Context): GroupInputs['useOutcomes'][] {
  const machine: DeviceView = { kind: 'machine', ownClaim: ctx.ownClaim }
  const hostname: DeviceView = { kind: 'hostname', ownClaim: ctx.altClaim }
  const unknown: DeviceView = { kind: null, ownClaim: null }
  const c = (name: string, response: Response, device: DeviceView = machine): GroupInputs['useOutcomes'] => ({ name, response, askedAt: NOW, major: 3, device })
  // A member given as undefined is one the answer leaves out.
  const spent = (extra: Record<string, unknown> = {}): Response => ({ status: 200, json: clean({ spent: true, meters: METERS, at: NOW + 7, ...extra }) })
  const usedUp = (extra: Record<string, unknown> = {}, status = 409): Response => ({ status, json: clean({ error: 'used-up', left: 1, meters: METERS, at: NOW + 7, ...extra }) })
  const words = ['revoked', 'expired', 'deactivated', 'upgrade-required', 'update-required', 'device']
  return [
    c('no answer at all: the wait and the machine kind', null),
    c('no answer at all, a host-name device: the wait, the install not keyed', null, hostname),
    c('no answer at all, a device of no kind: the wait, the install not keyed', null, unknown),
    c('a spend with its figures', spent()),
    c('a spend that confirms reports', spent({ spends: [{ id: id('A'), n: 3 }, { id: id('B'), void: true }] })),
    c('a spend with no time: no figures', { status: 200, json: { spent: true, meters: METERS } }),
    c('a spend with a time that is a fraction: no figures', spent({ at: 1.5 })),
    c('a spend with a time that is a text: no figures', spent({ at: '1789913600000' })),
    c('a spend with a negative time: no figures', spent({ at: -1 })),
    c('a spend with meters that are not an object: no figures', spent({ meters: 5 })),
    c('a spend with no meters: no figures', { status: 200, json: { spent: true, at: NOW } }),
    c('a spend with a malformed meter beside a good one: the good one', spent({ meters: { exports: { left: 3, total: 4, offline: 1 }, bad: { left: -1, total: 1, offline: 0 } } })),
    c('a spend with a meter named __proto__', { status: 200, json: JSON.parse('{"spent":true,"meters":{"__proto__":{"left":1,"total":2,"offline":0}},"at":1789913600000}') }),
    c('a 200 with spent as a text: no usable answer', spent({ spent: 'true' })),
    c('a 200 with spent false: no usable answer', spent({ spent: false })),
    c('a 200 with no spent: no usable answer', { status: 200, json: { meters: METERS, at: NOW } }),
    c('a 200 with a used-up word: no usable answer', { status: 200, json: { error: 'used-up', left: 0 } }),
    c('a 200 whose body is a text: no usable answer', { status: 200, json: 'ok' }),
    c('a 200 with no body: no usable answer', { status: 200, json: null }),
    c('a 200 whose body is a list: no usable answer', { status: 200, json: [] }),
    c('used-up with what is left, the figures and a confirmation', usedUp({ spends: [{ id: id('C'), n: 2 }] })),
    c('used-up with no left', usedUp({ left: undefined })),
    c('used-up with a left that is a fraction', usedUp({ left: 1.5 })),
    c('used-up with a negative left', usedUp({ left: -1 })),
    c('used-up with a left that is 0', usedUp({ left: 0 })),
    c('used-up with no time: no figures', usedUp({ at: undefined })),
    c('used-up on a 400', usedUp({}, 400)),
    c('used-up that confirms a void', usedUp({ spends: [{ id: id('D'), void: true }] })),
    c('unknown-meter with a confirmation', { status: 404, json: { error: 'unknown-meter', spends: [{ id: id('E'), n: 1 }] } }),
    c('unknown-meter with none', { status: 404, json: { error: 'unknown-meter' } }),
    c('a 404 for a key the server does not know: no usable answer', { status: 404, json: { error: 'invalid-key' } }),
    ...words.map((word) => c(`${word} on a 403: the verdict`, { status: 403, json: { error: word } })),
    c('revoked with a confirmation', { status: 403, json: { error: 'revoked', spends: [{ id: id('F'), n: 4 }] } }),
    c('revoked on a 401', { status: 401, json: { error: 'revoked' } }),
    c('device for a device that cannot say whose it is: for nobody', { status: 403, json: { error: 'device' } }, unknown),
    c('device for a host-name device: its own claim', { status: 403, json: { error: 'device' } }, hostname),
    c('upgrade-required for a device of no kind', { status: 403, json: { error: 'upgrade-required' } }, unknown),
    c('revoked for a host-name device', { status: 403, json: { error: 'revoked' } }, hostname),
    c('a word of its own on a 403: no usable answer', { status: 403, json: { error: 'something-new' } }),
    c('a 403 with no word: no usable answer', { status: 403, json: {} }),
    c('a 403 with a text body: no usable answer', { status: 403, json: 'denied' }),
    c('a 400 invalid-request: no usable answer', { status: 400, json: { error: 'invalid-request' } }),
    c('a 500 with a verdict word: no answer', { status: 500, json: { error: 'revoked' } }),
    c('a 503 with used-up: no answer', { status: 503, json: { error: 'used-up', left: 0, meters: METERS, at: NOW } }),
    c('a 429 with a confirmation: no answer', { status: 429, json: { error: 'rate-limited', spends: [{ id: id('G'), n: 1 }] } }),
    c('a 599: no answer', { status: 599, json: null }),
  ]
}

const OK = { status: 200, json: { lease: 'l' } }

export function spendConfirmations(): GroupInputs['spendConfirmations'][] {
  const c = (name: string, spends: unknown, status = 200): GroupInputs['spendConfirmations'] => ({ name, response: { status, json: { spends } } })
  const body = (name: string, response: Response): GroupInputs['spendConfirmations'] => ({ name, response })
  return [
    body('no answer at all', null),
    body('a 200 that names no reports', OK),
    c('a count', [{ id: id('A'), n: 3 }]),
    c('a void', [{ id: id('A'), void: true }]),
    c('both, in order', [{ id: id('B'), void: true }, { id: id('A'), n: 3 }]),
    c('an empty list', []),
    c('a list that is an object', { id: id('A'), n: 3 }),
    c('a list that is a text', 'A'),
    c('a member without an id', [{ n: 3 }]),
    c('a member whose id is a number', [{ id: 7, n: 3 }]),
    c('a count of 0', [{ id: id('A'), n: 0 }]),
    c('a negative count', [{ id: id('A'), n: -1 }]),
    c('a count that is a fraction', [{ id: id('A'), n: 1.5 }]),
    c('a count that is a text', [{ id: id('A'), n: '3' }]),
    c('a count that is null', [{ id: id('A'), n: null }]),
    c('a count past 2^53 - 1', [{ id: id('A'), n: 9007199254740992 }]),
    c('a count of 2^53 - 1', [{ id: id('A'), n: Number.MAX_SAFE_INTEGER }]),
    c('a member with neither a count nor a void', [{ id: id('A') }]),
    c('a void and a count: the void', [{ id: id('A'), void: true, n: 3 }]),
    c('a void that is false, with a count: the count', [{ id: id('A'), void: false, n: 3 }]),
    c('a void that is a text, with a count: the count', [{ id: id('A'), void: 'true', n: 3 }]),
    c('a void that is a text, alone: nothing', [{ id: id('A'), void: 'true' }]),
    c('a member without an id, a void', [{ void: true }]),
    c('other members are ignored', [{ id: id('A'), n: 3, extra: { a: 1 }, void: null }]),
    c('members that are not objects', ['x', 7, null, [1], { id: id('A'), n: 2 }]),
    c('the same id twice: both kept', [{ id: id('A'), n: 1 }, { id: id('A'), n: 2 }]),
    c('an id that is empty', [{ id: '', n: 1 }]),
    c('a count on a 403', [{ id: id('A'), n: 3 }], 403),
    c('a count on a 404', [{ id: id('A'), n: 3 }], 404),
    c('a count on a 409', [{ id: id('A'), n: 3 }], 409),
    c('a count on a 400', [{ id: id('A'), n: 3 }], 400),
    c('a count on a 499', [{ id: id('A'), n: 3 }], 499),
    c('a count on a 500: no answer', [{ id: id('A'), n: 3 }], 500),
    c('a count on a 503: no answer', [{ id: id('A'), n: 3 }], 503),
    c('a count on a 429: no answer', [{ id: id('A'), n: 3 }], 429),
    c('a count on a 599: no answer', [{ id: id('A'), n: 3 }], 599),
    body('a body that is a text', { status: 200, json: 'ok' }),
    body('a body that is null', { status: 200, json: null }),
    body('a body that is a list', { status: 200, json: [{ id: id('A'), n: 3 }] }),
  ]
}

export function spendReports(): GroupInputs['spendReports'][] {
  const c = (name: string, spends: SpendEntry[]): GroupInputs['spendReports'] => ({ name, spends })
  const many = (count: number): SpendEntry[] => Array.from({ length: count }, (_, i) => spend('unanswered', 1, { id: String(i).padStart(22, 'k'), meter: `m${i}`, at: NOW - 100_000 + i }))
  return [
    c('no entries: no report', []),
    c('an offline entry', [spend('offline', 4)]),
    c('an unanswered entry: its kind is not sent', [spend('unanswered', 1)]),
    c('a void marked', [spend('void', 2)]),
    c('every kind, in the journal’s order', [spend('offline', 4, { at: NOW - 3000 }), spend('unanswered', 1, { id: id('B'), at: NOW - 2000 }), spend('void', 2, { id: id('C'), at: NOW - 1000 })]),
    c('entries of several meters', [spend('offline', 4), spend('offline', 9, { id: id('B'), meter: 'renders' })]),
    c('an entry at the bound of n', [spend('offline', 1_000_000_000)]),
    c('64 entries: all reported', many(MAX_PENDING_SPENDS)),
    c('65 entries: the first 64', many(MAX_PENDING_SPENDS + 1)),
    c('a void first', [spend('void', 2, { at: NOW - 2000 }), spend('offline', 4, { id: id('B'), at: NOW - 1000 })]),
  ]
}
