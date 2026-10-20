/**
 * The key-pickup groups (the SDK contract, section 13): what `pickUp` sends
 * for what a person typed (`pickupAsk`), the error a refusal answers
 * (`pickupRefusal`), the keys read of a confirm's answer (`pickedKeysOf`), and
 * the key `restoreByEmail` activates (`chosenKey`).
 */
import { MAX_EMAIL, MAX_KEY } from '../../src/wire.js'
import type { PickedKey } from '../../src/types.js'
import type { GroupInputs } from '../inputs.js'

const ADDRESS = 'Mara@Studio.example'
const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
/** When a choice is judged. */
const NOW = 1_790_000_000_000

/** An address of exactly `length` characters. */
function addressOf(length: number): string {
  const tail = '@studio.example'
  return `${'a'.repeat(length - tail.length)}${tail}`
}

export function pickupAsks(): GroupInputs['pickupAsks'][] {
  const pairs: [string, string | null][] = [
    // The ask for a code: the address alone, as typed, trimmed of what a paste carries, and refused when blank.
    [ADDRESS, null],
    ['  Mara@Studio.example\n', null],
    ['﻿mara@studio.example\t', null],
    [' mara@studio.example ', null],
    ['', null],
    ['   ', null],
    ['　', null],
    // The longest address, measured after the trim, in UTF-16 units.
    [addressOf(MAX_EMAIL), null],
    [` ${addressOf(MAX_EMAIL)} `, null],
    [addressOf(MAX_EMAIL + 1), null],
    [`${'a'.repeat(MAX_EMAIL - 1)}\u{1F600}`, null],
    // A confirm: the address and six digits, spaced as a person types them off a mail.
    [ADDRESS, '123456'],
    [ADDRESS, '000042'],
    [ADDRESS, ' 123 456 '],
    [ADDRESS, ' 123456 '],
    // Not a code: blank, too few, too many, not digits, other scripts, other separators.
    [ADDRESS, ''],
    [ADDRESS, '  '],
    [ADDRESS, '12345'],
    [ADDRESS, '1234567'],
    [ADDRESS, 'abcdef'],
    [ADDRESS, '１２３４５６'],
    [ADDRESS, '123-456'],
    [ADDRESS, '123\t456'],
    // Both refused: the address is judged first.
    ['', '123456'],
    [addressOf(MAX_EMAIL + 1), 'nope'],
  ]
  return pairs.map(([email, code]) => ({ email, code }))
}

export function pickupRefusals(): GroupInputs['pickupRefusals'][] {
  const bodies: unknown[] = [
    // Each pickup word as itself.
    { error: 'pickup-disabled' },
    { error: 'wrong-code' },
    { error: 'code-expired' },
    { error: 'too-many-attempts', retryAfter: 3600 },
    { error: 'too-many-attempts' },
    { error: 'try-again', retryAfter: 60 },
    // The server's general words a pickup can meet.
    { error: 'rate-limited', retryAfter: 120 },
    { error: 'unavailable', retryAfter: 60 },
    { error: 'invalid-request' },
    // Anything else is no answer: an unknown product, an activation's word, a near miss, a body with no word.
    { error: 'unknown-product' },
    { error: 'limit' },
    { error: 'Wrong-Code' },
    { error: 'too_many_attempts' },
    { error: 7 },
    {},
    null,
    'Bad gateway',
    [],
    // A wait is kept only on the two words that wait, and only as whole seconds.
    { error: 'wrong-code', retryAfter: 60 },
    { error: 'too-many-attempts', retryAfter: 0 },
    { error: 'too-many-attempts', retryAfter: 1.5 },
    { error: 'too-many-attempts', retryAfter: -1 },
    { error: 'too-many-attempts', retryAfter: '60' },
    { error: 'rate-limited', retryAfter: null },
  ]
  return bodies.map((json) => ({ json }))
}

/** A key as the server answers it, every field given. */
const FULL = {
  key: KEY,
  model: 'subscription',
  modelName: 'Household',
  state: 'active',
  entitlements: { edition: 'pro', seats: 5, beta: true },
  expiresAt: 1_800_000_000_000,
  versions: { minMajor: 2, maxMajor: null, upgradeUntil: 1_795_000_000_000 },
  deviceLimit: 2,
  activeDevices: 1,
  held: true,
  sale: { id: 'sale_1', index: 3, size: 6 },
  userLock: 'code',
  activationCode: '012345',
}

export function pickedKeys(): GroupInputs['pickedKeys'][] {
  const one = (fields: Record<string, unknown>) => ({ keys: [{ key: KEY, ...fields }] })
  const bodies: unknown[] = [
    { keys: [] },
    { keys: [FULL] },
    { keys: [{ key: KEY }] },
    // No pickup answer at all.
    null,
    'ok',
    [],
    {},
    { keys: 'many' },
    { keys: null },
    { ok: true },
    // A member with no key is left out; the rest are kept in order.
    { keys: [{ key: '' }, { key: 7 }, 'SLUICE-AAAA', null, [], { model: 'perpetual' }, { key: KEY }, { key: 'SLUICE-SECOND' }] },
    { keys: [{ key: 'K'.repeat(MAX_KEY) }, { key: 'K'.repeat(MAX_KEY + 1) }] },
    // Versions: none for a key not yet bound, and none for what cannot be read; the members past minMajor fall back alone.
    one({ versions: null }),
    one({ versions: { minMajor: 2 } }),
    one({ versions: { minMajor: 1, maxMajor: 3, upgradeUntil: null } }),
    one({ versions: { minMajor: -1, maxMajor: 3 } }),
    one({ versions: { minMajor: 1.5 } }),
    one({ versions: 'all' }),
    one({ versions: { minMajor: 1, maxMajor: '3', upgradeUntil: -5 } }),
    // Held only for true.
    one({ held: 'true' }),
    one({ held: 1 }),
    // A sale only whole.
    one({ sale: { id: 'sale_1', index: 0, size: 6 } }),
    one({ sale: { id: 9, index: 1, size: 6 } }),
    one({ sale: { id: 'sale_1', index: 1 } }),
    // An activation code only as six ASCII digits.
    one({ activationCode: '12345' }),
    one({ activationCode: 123456 }),
    one({ activationCode: ' 123456' }),
    one({ activationCode: '１２３４５６' }),
    // Entitlements read as a lease's ent: a member that is no flag, number or text is left out.
    one({ entitlements: { edition: 'pro', nested: { a: 1 }, list: [1], none: null } }),
    one({ entitlements: ['pro'] }),
    // Numbers that are not whole numbers from 0 fall back; texts that are not texts fall back.
    one({ expiresAt: -5, deviceLimit: 2.5, activeDevices: -1 }),
    one({ expiresAt: '1800000000000', deviceLimit: '3', activeDevices: null }),
    one({ model: 7, modelName: 7, state: null }),
  ]
  return bodies.map((json) => ({ json }))
}

/** A picked key as read, with what a vector leaves out filled in: a perpetual key of major 1 with a free seat. */
function picked(over: Partial<PickedKey> = {}): PickedKey {
  return {
    key: KEY,
    model: 'perpetual',
    modelName: null,
    state: 'active',
    entitlements: {},
    expiresAt: null,
    versions: { minMajor: 1, maxMajor: 1, upgradeUntil: null },
    deviceLimit: 1,
    activeDevices: 0,
    held: false,
    ...over,
  }
}

export function pickupChoices(): GroupInputs['pickupChoices'][] {
  const full = (key: string, over: Partial<PickedKey> = {}) => picked({ key, activeDevices: 1, ...over })
  const range = (minMajor: number, maxMajor: number | null, upgradeUntil: number | null = null) => ({ versions: { minMajor, maxMajor, upgradeUntil } })
  const cases: { keys: PickedKey[]; major: number }[] = [
    // None at all.
    { keys: [], major: 1 },
    // One that covers, with a seat or not.
    { keys: [picked()], major: 1 },
    { keys: [full('A')], major: 1 },
    // The one this device holds, before one with a free seat; one with a free seat before a full one.
    { keys: [full('A'), picked({ key: 'B' }), full('C', { held: true })], major: 1 },
    { keys: [full('A'), full('B'), picked({ key: 'C' })], major: 1 },
    { keys: [full('A'), full('B')], major: 1 },
    // A held key that does not cover the build is passed over.
    { keys: [full('A', { held: true, ...range(1, 1) }), picked({ key: 'B', ...range(2, 2) })], major: 2 },
    // The versions: the bottom and top of a range, no top, an upgrade window open and closed, a key not yet bound.
    { keys: [picked(range(2, 3))], major: 2 },
    { keys: [picked(range(2, 3))], major: 3 },
    { keys: [picked(range(2, null))], major: 40 },
    { keys: [picked(range(1, 1, NOW + 1))], major: 5 },
    { keys: [picked(range(1, 1, NOW))], major: 5 },
    { keys: [picked({ versions: null })], major: 7 },
    { keys: [picked(range(1, 1)), picked({ key: 'B', versions: null })], major: 3 },
    // None covers the build: keys for an older major (buy an upgrade), for a later one (update the app), or both.
    { keys: [picked(range(1, 1))], major: 2 },
    { keys: [picked(range(3, null))], major: 2 },
    { keys: [picked(range(3, 4)), picked({ key: 'B', ...range(1, 1) })], major: 2 },
    { keys: [picked(range(2, 2, NOW - 1))], major: 1 },
  ]
  return cases.map(({ keys, major }) => ({ keys, major, now: NOW }))
}
