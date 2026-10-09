import { describe, it, expect } from 'vitest'
import { generateKeyPair, importSigningKey, signLease } from './crypto.js'
import { ENTITLEMENT_LIMITS, SettableEntitlements, type LeaseInput } from './lease.js'

/**
 * `SettableEntitlements`: what every write that sets entitlements holds them to
 * (a licence model's, a key's own, a product's trial ones). It is the signer's
 * rule and the server's caps, so a value the signer would refuse is refused
 * when it is saved, never when a key checks in.
 */

const NOW = 1_757_000_000_000

/** A lease carrying `ent`, as the server asks for one. */
function leaseWith(ent: unknown): LeaseInput {
  return { sub: 'K', product: 'p', aid: 'a', model: 'perpetual', lim: 1, major: 1, ent, ttlSeconds: 60 } as LeaseInput
}

/** Whether `signLease` signs a lease carrying `ent`. */
async function signs(ent: unknown): Promise<boolean> {
  const key = await importSigningKey((await generateKeyPair()).privateJwk)
  return signLease(leaseWith(ent), key, NOW).then(
    () => true,
    () => false,
  )
}

/** Every refusal the signer makes (crypto.test.ts holds the same list against `signLease`). */
const SIGNER_REFUSES: [string, unknown][] = [
  ['null', null],
  ['an empty list', []],
  ['a list', ['pro']],
  ['a text', 'pro'],
  ['a number', 42],
  ['a flag', true],
  ['a nested member', { tier: { name: 'gold' } }],
  ['a null member', { a: null }],
  ['a list member', { a: [1] }],
  ['an infinite number, which JSON would write as null', { seats: Number.POSITIVE_INFINITY }],
  ['a negative infinity', { seats: Number.NEGATIVE_INFINITY }],
  ['NaN', { seats: Number.NaN }],
  ['a member named __proto__, which signing would silently drop', JSON.parse('{"__proto__":"pro","seats":1}')],
  ['a text with a lone high surrogate', { edition: 'pro\ud800' }],
  ['a text with a lone low surrogate', { edition: '\udc00pro' }],
  ['a name with a lone low surrogate', { ['\udc00edition']: 'pro' }],
  ['a name with a lone high surrogate', { ['edition\ud83c']: 'pro' }],
  ['a name not in NFC, which Swift takes for its composed twin', { ['e\u0301dition']: 'pro' }],
  ['a name beside its canonical twin', { ['édition']: 'pro', ['e\u0301dition']: 'studio' }],
  ['the Kelvin sign, which NFC makes a K', { ['\u212a']: 1 }],
]

describe('SettableEntitlements refuses everything the signer refuses', () => {
  it.each(SIGNER_REFUSES)('%s', async (_case, ent) => {
    // The pair, together: a case the signer took would make this a test of
    // nothing, and the write rule must be at least as strict as the signer.
    expect(await signs(ent)).toBe(false)
    expect(SettableEntitlements.safeParse(ent).success).toBe(false)
  })
})

describe('SettableEntitlements takes what every SDK reads as meant, within the caps', () => {
  it.each<[string, Record<string, unknown>]>([
    ['none', {}],
    ['the Informant editions', { edition: 'pro', seats: 5 }],
    ['flags, numbers and texts of every kind', { beta: false, ratio: 0.5, discount: -2, big: 1e308, tiny: 5e-324, label: '' }],
    ['names and texts beyond ASCII, a surrogate pair included', { édition: 'Pro Studio ✓', emoji: '\u{1F3B5}' }],
    ['a text in decomposed form: only names must be in NFC', { edition: 'Pro e\u0301dition' }],
  ])('%s, which the signer signs too', async (_case, ent) => {
    const parsed = SettableEntitlements.safeParse(ent)
    expect(parsed.success && parsed.data).toEqual(ent)
    expect(await signs(ent)).toBe(true)
  })
})

describe('the caps, at each edge', () => {
  const settable = (ent: unknown) => SettableEntitlements.safeParse(ent).success
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, i]))

  it('are 16 entries, names of 1 to 32 characters and texts of at most 64', () => {
    expect(ENTITLEMENT_LIMITS).toEqual({ entries: 16, nameLength: 32, textLength: 64 })
  })

  it('takes 16 entitlements and refuses 17', async () => {
    expect(settable(many(16))).toBe(true)
    expect(settable(many(17))).toBe(false)
    // The signer has no cap: only a write is held to it.
    expect(await signs(many(17))).toBe(true)
  })

  it('takes a name of 1 and of 32 characters, and refuses an empty one and one of 33', async () => {
    expect(settable({ a: true })).toBe(true)
    expect(settable({ ['n'.repeat(32)]: true })).toBe(true)
    expect(settable({ '': true })).toBe(false)
    expect(settable({ ['n'.repeat(33)]: true })).toBe(false)
    expect(await signs({ '': true, ['n'.repeat(33)]: true })).toBe(true)
  })

  it('takes a text of 64 characters and refuses one of 65', async () => {
    expect(settable({ edition: 'v'.repeat(64) })).toBe(true)
    expect(settable({ edition: 'v'.repeat(65) })).toBe(false)
    expect(await signs({ edition: 'v'.repeat(65) })).toBe(true)
  })

  it('counts in UTF-16 units, as the server does: a surrogate pair is two', () => {
    const note = '\u{1F3B5}' // two units
    expect(settable({ edition: note.repeat(32) })).toBe(true)
    expect(settable({ edition: `${note.repeat(32)}x` })).toBe(false)
    expect(settable({ [note.repeat(16)]: true })).toBe(true)
    expect(settable({ [`${note.repeat(16)}x`]: true })).toBe(false)
  })

  it('measures numbers and flags by nothing: only texts have a length', () => {
    expect(settable({ seats: 123456789012345680000 })).toBe(true)
    expect(settable({ beta: true })).toBe(true)
  })
})
