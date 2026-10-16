import { describe, it, expect } from 'vitest'
import { generateKeyPair, importSigningKey, importVerifyingKeys, signLease, verifyLease } from './crypto.js'
import { LeaseClaims, MAX_METER_USES, METER_LIMITS, SettableMeters, metersOf, type LeaseInput } from './lease.js'

/**
 * A lease's `met` (sdk-contract.md 12.1): signed strictly by the server within
 * its caps, read leniently by a verifier, and absent from the lease of a key
 * with no meter, which is byte for byte what it was before meters.
 */

const NOW = 1_757_000_000_000

function leaseWith(extra: Record<string, unknown>): LeaseInput {
  return { sub: 'K', product: 'p', aid: 'a', model: 'perpetual', lim: 1, major: 1, ent: {}, ttlSeconds: 60, ...extra } as LeaseInput
}

async function signed(extra: Record<string, unknown>): Promise<string> {
  const pair = await generateKeyPair()
  return signLease(leaseWith(extra), await importSigningKey(pair.privateJwk), NOW)
}

/** Whether `signLease` signs a lease carrying `met`. */
async function signs(met: unknown): Promise<boolean> {
  return signed({ met }).then(
    () => true,
    () => false,
  )
}

/** The first thing wrong with a `met` the signer refused: where and why; null when it signs. */
async function refusal(met: unknown): Promise<{ path: string; message: string } | null> {
  try {
    await signed({ met })
    return null
  } catch (e) {
    const issue = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0]
    return issue ? { path: issue.path.join('.'), message: issue.message } : { path: '', message: String(e) }
  }
}

const base64url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const payloadOf = (token: string): Record<string, unknown> => JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')))

describe('signing met', () => {
  it('signs a meter as { left, total, offline } and resets: true only on a period meter', async () => {
    const token = await signed({ met: { exports: { left: 950, total: 1000, offline: 100 }, renders: { left: 5, total: 50, offline: 5, resets: true } } })
    expect(payloadOf(token).met).toEqual({ exports: { left: 950, total: 1000, offline: 100 }, renders: { left: 5, total: 50, offline: 5, resets: true } })
    // The member order is the contract's: left, total, offline, resets.
    expect(JSON.stringify(payloadOf(token).met)).toBe('{"exports":{"left":950,"total":1000,"offline":100},"renders":{"left":5,"total":50,"offline":5,"resets":true}}')
  })

  it('writes no met for a key with no meter, so the lease is what it was', async () => {
    const without = payloadOf(await signed({}))
    expect('met' in without).toBe(false)
    const none = payloadOf(await signed({ met: undefined }))
    expect(Object.keys(none)).toEqual(Object.keys(without))
  })

  it('writes met after ent, before the times', async () => {
    const keys = Object.keys(payloadOf(await signed({ met: { a: { left: 1, total: 1, offline: 0 } } })))
    expect(keys.indexOf('met')).toBe(keys.indexOf('ent') + 1)
    expect(keys.indexOf('met')).toBeLessThan(keys.indexOf('iat'))
  })

  /**
   * Every lease `signLease` refuses a `met` for: what is wrong, where (the path in the claims), and the reason it gives when
   * the reason is the project's own words. Zod's built-in messages (a type, a range) are its to change: those are pinned by path alone (null).
   */
  const REFUSED: [string, unknown, string, RegExp | null][] = [
    ['null', null, 'met', null],
    ['a list', [], 'met', null],
    ['a text', 'x', 'met', null],
    ['a member that is not an object', { a: 3 }, 'met.a', null],
    ['a figure missing', { a: { left: 1, total: 1 } }, 'met.a.offline', null],
    ['a negative figure', { a: { left: -1, total: 1, offline: 0 } }, 'met.a.left', null],
    ['a fractional figure', { a: { left: 1.5, total: 2, offline: 0 } }, 'met.a.left', null],
    ['a figure past MAX_METER_USES', { a: { left: 1, total: MAX_METER_USES + 1, offline: 0 } }, 'met.a.total', null],
    ['left above total', { a: { left: 2, total: 1, offline: 0 } }, 'met.a', /left is at most total/],
    ['resets: false', { a: { left: 1, total: 1, offline: 0, resets: false } }, 'met.a.resets', null],
    ['a member more', { a: { left: 1, total: 1, offline: 0, extra: 1 } }, 'met.a', null],
    ['nine meters', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}`, { left: 1, total: 1, offline: 0 }])), 'met', /at most 8 meters/],
    ['an empty code', { '': { left: 1, total: 1, offline: 0 } }, 'met.', /a code the signer takes/],
    ['a code of 33 characters', { ['x'.repeat(33)]: { left: 1, total: 1, offline: 0 } }, `met.${'x'.repeat(33)}`, /a code the signer takes/],
    // "e" and a combining acute accent: the same letter, not composed.
    ['a code not in NFC', { ['e\u0301']: { left: 1, total: 1, offline: 0 } }, 'met.e\u0301', /a code the signer takes/],
    ['a code with a lone surrogate', { ['a\ud800']: { left: 1, total: 1, offline: 0 } }, 'met.a\ud800', /a code the signer takes/],
    ['a member named __proto__', JSON.parse('{"__proto__":{"left":1,"total":1,"offline":0}}'), 'met', /may not be named __proto__/],
  ]
  it.each(REFUSED)('refuses %s', async (_name, met, path, why) => {
    expect(await signs(met)).toBe(false)
    // And says what is wrong and where, so a mint that writes a meter wrongly fails loudly in the right place.
    const issue = await refusal(met)
    expect(issue?.path).toBe(path)
    if (why) expect(issue?.message).toMatch(why)
  })

  it('takes the bounds: eight meters, a code of 32, and MAX_METER_USES', async () => {
    const eight = Object.fromEntries(Array.from({ length: METER_LIMITS.entries }, (_, i) => [`m${i}`, { left: 0, total: 0, offline: 0 }]))
    expect(await signs(eight)).toBe(true)
    expect(await signs({ ['x'.repeat(32)]: { left: MAX_METER_USES, total: MAX_METER_USES, offline: MAX_METER_USES } })).toBe(true)
  })

  it('holds a write to exactly what the signer signs (SettableMeters)', () => {
    expect(SettableMeters.safeParse({ a: { left: 1, total: 2, offline: 0 } }).success).toBe(true)
    expect(SettableMeters.safeParse({ a: { left: 3, total: 2, offline: 0 } }).success).toBe(false)
  })
})

describe('reading met', () => {
  it('reads the meters of a signed lease, with resets a flag', async () => {
    const pair = await generateKeyPair()
    const key = await importSigningKey(pair.privateJwk)
    const token = await signLease(leaseWith({ met: { exports: { left: 3, total: 10, offline: 1 }, renders: { left: 0, total: 5, offline: 0, resets: true } } }), key, NOW)
    const verified = await verifyLease(token, await importVerifyingKeys([pair.publicJwk]), NOW)
    expect(verified.valid && verified.claims.met).toEqual({
      exports: { left: 3, total: 10, offline: 1, resets: false },
      renders: { left: 0, total: 5, offline: 0, resets: true },
    })
  })

  it('refuses a lease whose met was changed after it was signed: the signature covers every figure', async () => {
    const pair = await generateKeyPair()
    const token = await signLease(leaseWith({ met: { exports: { left: 3, total: 10, offline: 1 } } }), await importSigningKey(pair.privateJwk), NOW)
    const keys = await importVerifyingKeys([pair.publicJwk])
    expect(await verifyLease(token, keys, NOW)).toMatchObject({ valid: true })
    // A customer who gives themselves seven more uses by editing the lease they hold.
    const [header, , signature] = token.split('.')
    const claims = payloadOf(token) as { met: { exports: { left: number } } }
    claims.met.exports.left = 10
    const forged = [header, base64url(JSON.stringify(claims)), signature].join('.')
    expect(await verifyLease(forged, keys, NOW)).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('leaves a lease with no met without one in its claims', async () => {
    const pair = await generateKeyPair()
    const token = await signLease(leaseWith({}), await importSigningKey(pair.privateJwk), NOW)
    const verified = await verifyLease(token, await importVerifyingKeys([pair.publicJwk]), NOW)
    expect(verified.valid && 'met' in verified.claims).toBe(false)
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a list', [{ left: 1, total: 1, offline: 0 }]],
    ['a text', 'meters'],
    ['a number', 7],
    ['a flag', true],
  ])('reads %s as no meters', (_name, raw) => {
    expect(metersOf(raw)).toEqual({})
  })

  it('drops a member with a figure missing, negative, fractional, textual or past 2^53 - 1, never the meters beside it', () => {
    const good = { left: 1, total: 2, offline: 0 }
    const read = metersOf({
      good,
      noLeft: { total: 2, offline: 0 },
      negative: { left: -1, total: 2, offline: 0 },
      fraction: { left: 1.5, total: 2, offline: 0 },
      text: { left: '1', total: 2, offline: 0 },
      notAnObject: 4,
      aList: [1, 2, 3],
      aNull: null,
      past: { left: 1, total: Number.MAX_SAFE_INTEGER + 1, offline: 0 },
    })
    expect(Object.keys(read)).toEqual(['good'])
  })

  it('keeps 2^53 - 1, and a figure the server would never sign (the caps are the signer\'s)', () => {
    const read = metersOf({ big: { left: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER, offline: 0 }, over: { left: 5, total: 3, offline: 0 } })
    expect(Object.keys(read)).toEqual(['big', 'over'])
  })

  it('reads resets only when the member says true, and a member named __proto__ as a meter', () => {
    const read = metersOf(JSON.parse('{"a":{"left":4,"total":4,"offline":0,"resets":true},"b":{"left":1,"total":1,"offline":0,"resets":"yes"},"__proto__":{"left":1,"total":1,"offline":0}}'))
    expect(read.a).toEqual({ left: 4, total: 4, offline: 0, resets: true })
    expect(read.b?.resets).toBe(false)
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(Object.keys(read)).toEqual(['a', 'b', '__proto__'])
  })

  it('is part of the claims schema as a lenient reader', () => {
    const parsed = LeaseClaims.parse({ iss: 'keygrant', sub: 'K', product: 'p', aid: 'a', model: 'perpetual', lim: 1, iat: 1, exp: 2, met: { a: { left: 1, total: 1, offline: 0 }, bad: 1 } })
    expect(Object.keys(parsed.met ?? {})).toEqual(['a'])
  })
})
