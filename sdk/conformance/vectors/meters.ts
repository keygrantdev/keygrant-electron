/**
 * The metered-uses groups about a lease and the figures read from it (the SDK contract, 12.1, 12.3,
 * 12.4, 12.7, 12.8): the `met` claim a verifier reads (`meterClaims`, `meterLeases`), what a call may
 * ask for (`useAmounts`), the base figures of each meter (`meterFigures`), the status's meters
 * (`meterStatuses`) and whether a spend with no answer is allowed (`offlineSpends`).
 */
import { MAX_METER_USES } from '@keygrant/shared'
import type { BaseFigure, MeterFigure, SpendEntry } from '../../src/meter-types.js'
import type { LeaseVector, GroupInputs } from '../inputs.js'
import { HEADER, NOW, NOW_S, b64url, claims, sign, signInput, utf8, part, type Context } from './common.js'
import { leaseVectors, type LeaseCase } from './leases.js'

/** A meter's figures. */
export const fig = (left: number, total: number, offline: number, resets = false): BaseFigure => ({ left, total, offline, resets })

/** A figure as a `use` answer stored it, at the server's time `at`. */
export const stored = (left: number, total: number, offline: number, at: number, resets = false): MeterFigure => ({ left, total, offline, resets, at })

/** A journal entry, by kind; ids are 22 characters. */
export const spend = (kind: SpendEntry['kind'], n: number, over: Partial<SpendEntry> = {}): SpendEntry => ({
  id: `${kind[0]}${'A'.repeat(21)}`,
  meter: 'exports',
  n,
  at: NOW - 60_000,
  kind,
  ...over,
})

/** A meter of a lease's `met` as the server writes it. */
const M = '{"left":4,"total":10,"offline":1}'

export function meterClaims(): GroupInputs['meterClaims'][] {
  const one = (member: string, code = 'exports') => `{"${code}":${member}}`
  const cases: [string, string | null][] = [
    ['absent: the lease has no met', null],
    ['null', 'null'],
    ['an empty list', '[]'],
    ['a list of meters', '[{"left":1,"total":1,"offline":1}]'],
    ['a text', '"exports"'],
    ['a number', '7'],
    ['a flag', 'true'],
    ['an empty object', '{}'],
    ['one meter', one(M)],
    ['resets true', one('{"left":4,"total":10,"offline":1,"resets":true}')],
    ['resets false', one('{"left":4,"total":10,"offline":1,"resets":false}')],
    ['resets a text', one('{"left":4,"total":10,"offline":1,"resets":"true"}')],
    ['resets a number', one('{"left":4,"total":10,"offline":1,"resets":1}')],
    ['resets null', one('{"left":4,"total":10,"offline":1,"resets":null}')],
    ['no left', one('{"total":10,"offline":1}')],
    ['no total', one('{"left":4,"offline":1}')],
    ['no offline', one('{"left":4,"total":10}')],
    ['a negative left', one('{"left":-1,"total":10,"offline":1}')],
    ['a negative total', one('{"left":4,"total":-10,"offline":1}')],
    ['a negative offline', one('{"left":4,"total":10,"offline":-1}')],
    ['a fractional left', one('{"left":1.5,"total":10,"offline":1}')],
    ['a fractional total', one('{"left":4,"total":10.5,"offline":1}')],
    ['a fractional offline', one('{"left":4,"total":10,"offline":0.5}')],
    ['4.0, which is 4', one('{"left":4.0,"total":10.0,"offline":1.0}')],
    ['written with an exponent: 1e1 is 10', one('{"left":4e0,"total":1e1,"offline":1E0}')],
    ['a text for a number', one('{"left":"4","total":10,"offline":1}')],
    ['a null figure', one('{"left":null,"total":10,"offline":1}')],
    ['a flag for a number', one('{"left":true,"total":10,"offline":1}')],
    ['a list for a number', one('{"left":[4],"total":10,"offline":1}')],
    ['a member that is a number', one('5')],
    ['a member that is a text', one('"x"')],
    ['a member that is null', one('null')],
    ['a member that is a list', one('[4,10,1]')],
    ['other members of a meter are ignored', one('{"left":4,"total":10,"offline":1,"overage":3,"extra":{"a":1}}')],
    ['a meter named __proto__ is a meter like any other', `{"__proto__":${M}}`],
    ['a meter named constructor', one(M, 'constructor')],
    ['a malformed meter beside good ones: only it is dropped', `{"a":${M},"b":{"left":-1,"total":10,"offline":1},"c":${M}}`],
    ['nine meters, all kept: the server’s caps are not enforced', `{${'abcdefghi'.split('').map((c) => `"${c}":${M}`).join(',')}}`],
    ['left above total, kept', one('{"left":20,"total":10,"offline":1}')],
    ['a figure past MAX_METER_USES, kept', one(`{"left":${MAX_METER_USES + 1},"total":${MAX_METER_USES * 2},"offline":1}`)],
    ['zero figures', one('{"left":0,"total":0,"offline":0}')],
    ['2^53 - 1, the largest whole number a double holds, kept', one(`{"left":${Number.MAX_SAFE_INTEGER},"total":${Number.MAX_SAFE_INTEGER},"offline":${Number.MAX_SAFE_INTEGER}}`)],
    ['2^53, dropped', one('{"left":9007199254740992,"total":10,"offline":1}')],
    ['2^53 + 1, which a double reads as 2^53, dropped', one('{"left":9007199254740993,"total":10,"offline":1}')],
    ['-0 is 0', one('{"left":-0,"total":10,"offline":1}')],
    ['1e400, out of a double’s range, is no whole number: dropped', one('{"left":1e400,"total":10,"offline":1}')],
    ['an empty name', `{"":${M}}`],
    ['a name beyond ASCII', `{"éxports":${M}}`],
  ]
  return cases.map(([name, json]) => ({ name, json }))
}

/** A lease payload written as text, so its `met` can say what no JSON.stringify writes (`4.0`). */
async function leaseWithText(met: string): Promise<string> {
  const text = `${JSON.stringify(claims()).slice(0, -1)},"met":${met}}`
  return signInput(`${part(HEADER)}.${b64url(utf8(text))}`)
}

export async function meterLeases(ctx: Context): Promise<LeaseVector[]> {
  const signed = { exports: { left: 90, total: 100, offline: 10 } }
  const eight = Object.fromEntries('abcdefgh'.split('').map((c) => [c, { left: 1, total: 2, offline: 0 }]))
  const cases: LeaseCase[] = [
    { name: 'a lease with no met: unchanged', token: await sign(claims()) },
    { name: 'a lease with one meter', token: await sign(claims({ met: signed })) },
    { name: 'a lease with two meters, one that resets', token: await sign(claims({ met: { ...signed, renders: { left: 5, total: 5, offline: 0, resets: true } } })) },
    { name: 'a lease with eight meters', token: await sign(claims({ met: eight })) },
    { name: 'a lease with a meter whose allowance is 0', token: await sign(claims({ met: { exports: { left: 3, total: 3, offline: 0 } } })) },
    { name: 'a test lease with meters', token: await sign(claims({ met: signed, test: true })) },
    { name: 'a lease in its grace window with meters', token: await sign(claims({ met: signed, grace: true, model: 'subscription' })) },
    { name: 'met null: no meters', token: await sign(claims({ met: null })) },
    { name: 'met a list: no meters', token: await sign(claims({ met: [] })) },
    { name: 'met a text: no meters', token: await sign(claims({ met: 'exports' })) },
    { name: 'met a number: no meters', token: await sign(claims({ met: 7 })) },
    { name: 'met a flag: no meters', token: await sign(claims({ met: true })) },
    { name: 'met an empty object', token: await sign(claims({ met: {} })) },
    { name: 'a malformed meter beside a good one: only it is dropped', token: await sign(claims({ met: { ...signed, bad: { left: -1, total: 2, offline: 0 } } })) },
    { name: 'a figure written 4.0 is 4', token: await leaseWithText('{"exports":{"left":4.0,"total":10.0,"offline":1.0}}') },
    { name: 'a figure written with an exponent', token: await leaseWithText('{"exports":{"left":9e0,"total":1e1,"offline":0}}') },
    { name: 'a figure past 2^53 - 1 drops its meter', token: await leaseWithText('{"exports":{"left":1,"total":9007199254740993,"offline":0},"kept":{"left":1,"total":2,"offline":0}}') },
    { name: 'a meter named __proto__', token: await leaseWithText('{"__proto__":{"left":1,"total":2,"offline":0}}') },
    { name: 'an expired lease with meters: the claims are still returned', token: await sign(claims({ met: signed, exp: NOW_S - 1 })) },
    { name: 'a lease for another product with meters: tampered', token: await sign(claims({ met: signed, product: 'maindeck' })) },
    { name: 'a build newer than the lease covers, with meters', token: await sign(claims({ met: signed })), major: 4 },
    { name: 'a lease with meters and an entitlement', token: await sign(claims({ met: signed, ent: { edition: 'pro' } })) },
  ]
  return leaseVectors(cases, ctx)
}

/** A code of `units` UTF-16 units that ends in a surrogate pair. */
const pairAt = (units: number) => `${'x'.repeat(units - 2)}😀`

export function useAmounts(): GroupInputs['useAmounts'][] {
  const meter = 'exports'
  const c = (name: string, rest: { meter?: string; n?: unknown; jsOnly?: true }): GroupInputs['useAmounts'] => ({ name, meter, ...rest })
  return [
    c('n absent is 1', {}),
    c('1', { n: 1 }),
    c('a batch', { n: 40 }),
    c('the bound', { n: MAX_METER_USES }),
    c('0', { n: 0 }),
    c('a negative', { n: -1 }),
    c('one past the bound', { n: MAX_METER_USES + 1 }),
    c('a fraction', { n: 1.5, jsOnly: true }),
    c('a text', { n: '3', jsOnly: true }),
    c('a code of 1 unit', { meter: 'x', n: 1 }),
    c('a code of 32 units', { meter: 'x'.repeat(32), n: 1 }),
    c('a code of 33 units', { meter: 'x'.repeat(33), n: 1 }),
    c('an empty code', { meter: '', n: 1 }),
    c('a code ending in a surrogate pair, 32 units', { meter: pairAt(32), n: 1 }),
    c('a code ending in a surrogate pair, 33 units', { meter: pairAt(33), n: 1 }),
    c('a code of 16 characters of 2 units each', { meter: '😀'.repeat(16), n: 1 }),
    c('a code of 17 characters of 2 units each', { meter: '😀'.repeat(17), n: 1 }),
    c('a code beyond ASCII, 3 characters', { meter: 'éxé', n: 2 }),
    c('a code with a space, kept as typed', { meter: 'a b', n: 2 }),
    c('a code in capitals is another code', { meter: 'EXPORTS', n: 1 }),
    c('the amount is judged before the code: 0 and an empty code', { meter: '', n: 0 }),
    c('a bad amount and a long code', { meter: 'x'.repeat(33), n: -5 }),
    c('absent n and an empty code', { meter: '' }),
  ]
}

export function meterFigures(): GroupInputs['meterFigures'][] {
  const iat = NOW_S - 100
  const at = iat * 1000
  const lease = { exports: fig(90, 100, 10), renders: fig(5, 5, 0, true) }
  const c = (name: string, figures: Record<string, MeterFigure>, met: Record<string, BaseFigure> = lease): GroupInputs['meterFigures'] => ({ name, met, iat, figures })
  return [
    c('nothing stored: the lease’s figures', {}),
    c('a stored figure newer by a second', { exports: stored(50, 100, 10, at + 1000) }),
    c('a stored figure from the lease’s own second', { exports: stored(50, 100, 10, at) }),
    c('a stored figure late in the lease’s second', { exports: stored(50, 100, 10, at + 999) }),
    c('a stored figure a millisecond before the lease’s second', { exports: stored(50, 100, 10, at - 1) }),
    c('a stored figure from long before', { exports: stored(50, 100, 10, at - 86_400_000) }),
    c('two meters: one stored newer, one older', { exports: stored(50, 100, 10, at + 5), renders: stored(1, 5, 0, at - 5, true) }),
    c('a stored figure that changes everything: total, allowance and whether it resets', { renders: stored(2, 8, 3, at + 1, false) }),
    c('a meter only a newer stored figure names: a new meter', { added: stored(7, 7, 1, at + 1) }),
    c('a meter only an older stored figure names: gone', { gone: stored(7, 7, 1, at - 1) }),
    c('the lease names none, and a newer stored figure names one', { exports: stored(9, 9, 0, at + 1) }, {}),
    c('the lease names none, and nothing is stored', {}, {}),
    c('the lease names none, and an older stored figure names one: gone', { exports: stored(9, 9, 0, at - 1) }, {}),
  ]
}

export function meterStatuses(): GroupInputs['meterStatuses'][] {
  const figures = { exports: fig(90, 100, 10), renders: fig(5, 5, 0, true) }
  const c = (name: string, spends: SpendEntry[], f: Record<string, BaseFigure> = figures): GroupInputs['meterStatuses'] => ({ name, figures: f, spends })
  const id = (n: number) => String(n).padStart(22, 'k')
  return [
    c('no figures: no meters', [], {}),
    c('one meter and no journal', [], { exports: fig(90, 100, 10) }),
    c('offline spends counted', [spend('offline', 4)]),
    c('an unanswered spend counted', [spend('unanswered', 3)]),
    c('a void counted for nothing', [spend('void', 50)]),
    c('all three kinds: only the first two counted', [spend('offline', 4), spend('unanswered', 3, { id: id(1) }), spend('void', 50, { id: id(2) })]),
    c('several unanswered spends of one meter', [spend('unanswered', 2, { id: id(1) }), spend('unanswered', 5, { id: id(2) })]),
    c('left floored at 0', [spend('offline', 95)]),
    c('left exactly spent', [spend('offline', 90)]),
    c('a meter that resets', [spend('offline', 2, { meter: 'renders' })]),
    c('the journal split between two meters', [spend('offline', 4), spend('offline', 5, { id: id(1), meter: 'renders' })]),
    c('an entry for a meter with no figure shows nothing', [spend('offline', 4, { meter: 'credits' })]),
    c('no entry for a meter with a figure', [spend('offline', 4, { meter: 'credits' })], { exports: fig(90, 100, 10) }),
  ]
}

export function offlineSpends(): GroupInputs['offlineSpends'][] {
  const c = (name: string, spends: SpendEntry[], n: number, f: Record<string, BaseFigure> = { exports: fig(90, 100, 10) }, meter = 'exports'): GroupInputs['offlineSpends'] => ({ name, figures: f, spends, meter, n })
  const id = (n: number) => String(n).padStart(22, 'k')
  return [
    c('one use from a full allowance', [], 1),
    c('exactly the allowance', [], 10),
    c('one past the allowance', [], 11),
    c('exactly what is left', [], 4, { exports: fig(4, 100, 10) }),
    c('one past what is left', [], 5, { exports: fig(4, 100, 10) }),
    c('past both', [], 50, { exports: fig(4, 100, 10) }),
    c('an allowance of 0 refuses every spend', [], 1, { exports: fig(90, 100, 0) }),
    c('nothing left refuses every spend', [], 1, { exports: fig(0, 100, 10) }),
    c('the allowance spent by an offline entry, exactly', [spend('offline', 9)], 1),
    c('one past the allowance with an offline entry', [spend('offline', 9)], 2),
    c('an unanswered spend counts toward the allowance, exactly', [spend('unanswered', 6)], 4),
    c('one past the allowance with an unanswered spend', [spend('unanswered', 6)], 5),
    c('both kinds together reach the allowance exactly', [spend('offline', 4), spend('unanswered', 3, { id: id(1) })], 3),
    c('a void is not counted', [spend('void', 50)], 10),
    c('a void beside spends: only the spends count', [spend('offline', 4), spend('void', 50, { id: id(1) })], 7),
    c('another meter’s spends are not counted', [spend('offline', 9, { meter: 'renders' })], 10),
    c('unsynced spends past what is left floor it at 0', [spend('offline', 12)], 1, { exports: fig(5, 100, 50) }),
    c('what is left less the unsynced, exactly', [spend('offline', 2)], 3, { exports: fig(5, 100, 50) }),
    c('one past what is left less the unsynced', [spend('offline', 2)], 4, { exports: fig(5, 100, 50) }),
    c('the limit is the allowance when that is below what is left', [spend('offline', 2)], 3),
    c('the limit is what is left when that is below the allowance', [], 2, { exports: fig(5, 100, 50) }),
    c('the limit is the same when the allowance is what is left', [], 3, { exports: fig(10, 100, 10) }),
    c('a meter the key has no figure for', [], 1, { renders: fig(5, 5, 0, true) }, 'exports'),
    c('a meter named like an Object.prototype member, with no figure', [], 1, { exports: fig(90, 100, 10) }, 'constructor'),
    c('a meter named like an Object.prototype member, with a figure', [], 1, JSON.parse('{"constructor":{"left":3,"total":3,"offline":1,"resets":false}}') as Record<string, BaseFigure>, 'constructor'),
  ]
}
