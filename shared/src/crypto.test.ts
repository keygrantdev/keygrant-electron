import { describe, it, expect } from 'vitest'
import {
  fingerprintClaim,
  generateKeyPair,
  importSigningKey,
  importVerifyingKey,
  signLease,
  verifyLease,
} from './crypto.js'
import { DEFAULT_TTL_SECONDS, MAX_MAJOR, OPEN_MAJOR, type Entitlements, type LeaseInput } from './lease.js'

const NOW = 1_757_000_000_000 // fixed clock (ms) for determinism

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Produce a JWS with a valid signature over an arbitrary (possibly invalid) payload. */
async function signRaw(claims: unknown, privateJwk: JsonWebKey): Promise<string> {
  const key = await importSigningKey(privateJwk)
  const enc = new TextEncoder()
  const header = b64url(enc.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })))
  const payload = b64url(enc.encode(JSON.stringify(claims)))
  const input = `${header}.${payload}`
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, enc.encode(input)))
  return `${input}.${b64url(sig)}`
}

function sampleLease(overrides: Partial<LeaseInput> = {}): LeaseInput {
  return {
    sub: 'SLUICE-ABCD-EFGH-JKLM-NPQR',
    product: 'sluice',
    aid: 'act_123',
    model: 'perpetual',
    lim: 3,
    major: 1,
    ent: {},
    ttlSeconds: DEFAULT_TTL_SECONDS.perpetual,
    ...overrides,
  }
}

describe('JWT lease sign/verify loop', () => {
  it('signs a lease and verifies it offline against the public key', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const signingKey = await importSigningKey(privateJwk)
    const verifyingKey = await importVerifyingKey(publicJwk)

    const token = await signLease(sampleLease(), signingKey, NOW)
    expect(token.split('.')).toHaveLength(3) // compact JWS

    const result = await verifyLease(token, verifyingKey, NOW)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.claims.sub).toBe('SLUICE-ABCD-EFGH-JKLM-NPQR')
      expect(result.claims.iss).toBe('keygrant')
      expect(result.claims.exp).toBe(result.claims.iat + DEFAULT_TTL_SECONDS.perpetual)
    }
  })

  it('rejects a lease signed by a different product key', async () => {
    const productA = await generateKeyPair()
    const productB = await generateKeyPair()
    const token = await signLease(sampleLease(), await importSigningKey(productA.privateJwk), NOW)

    const result = await verifyLease(token, await importVerifyingKey(productB.publicJwk), NOW)
    expect(result).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('rejects a tampered payload', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const token = await signLease(sampleLease(), await importSigningKey(privateJwk), NOW)

    const [h, , s] = token.split('.')
    const forged = btoa(JSON.stringify({ iss: 'keygrant', sub: 'PIRATE', exp: 9e9 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const tampered = `${h}.${forged}.${s}`

    const result = await verifyLease(tampered, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toBe('bad-signature')
  })

  it('reports malformed for a token without three segments', async () => {
    const { publicJwk } = await generateKeyPair()
    const result = await verifyLease('only.two', await importVerifyingKey(publicJwk), NOW)
    expect(result).toEqual({ valid: false, reason: 'malformed' })
  })

  it('reports bad-claims for a validly-signed token whose payload fails the schema', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    // Sign a real signature over a payload missing required lease claims.
    const token = await signRaw({ iss: 'keygrant', sub: 'X' }, privateJwk)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toBe('bad-claims')
  })

  it('reports expiry once the lease TTL has passed (grace boundary)', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const token = await signLease(
      sampleLease({ model: 'subscription', ttlSeconds: DEFAULT_TTL_SECONDS.subscription }),
      await importSigningKey(privateJwk),
      NOW,
    )
    const verifyingKey = await importVerifyingKey(publicJwk)

    const stillValid = await verifyLease(token, verifyingKey, NOW + 6 * 24 * 60 * 60 * 1000)
    expect(stillValid.valid).toBe(true)

    const expired = await verifyLease(token, verifyingKey, NOW + 8 * 24 * 60 * 60 * 1000)
    expect(expired.valid).toBe(false)
    if (!expired.valid) {
      expect(expired.reason).toBe('expired')
      expect(expired.claims?.sub).toBe('SLUICE-ABCD-EFGH-JKLM-NPQR') // claims still surfaced
    }
  })
})

describe('the grace claim', () => {
  it('survives a sign/verify round trip', async () => {
    // The SDK reads this to decide whether to nag or to lock. A claim that is
    // dropped in signing would silently turn a grace window back into a cut-off.
    const { publicJwk, privateJwk } = await generateKeyPair()
    const signingKey = await importSigningKey(privateJwk)
    const token = await signLease(
      {
        sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD',
        product: 'sluice',
        aid: 'act_1',
        model: 'subscription',
        lim: 3,
        major: 1,
        ent: {},
        grace: true,
        ttlSeconds: 3600,
      },
      signingKey,
    )
    const verified = await verifyLease(token, await importVerifyingKey(publicJwk))
    expect(verified.valid).toBe(true)
    if (verified.valid) expect(verified.claims.grace).toBe(true)
  })

  it('is simply absent on a healthy lease', async () => {
    const { publicJwk, privateJwk } = await generateKeyPair()
    const token = await signLease(
      {
        sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD',
        product: 'sluice',
        aid: 'act_1',
        model: 'perpetual',
        lim: 3,
        major: 1,
        ent: {},
        ttlSeconds: 3600,
      },
      await importSigningKey(privateJwk),
    )
    const verified = await verifyLease(token, await importVerifyingKey(publicJwk))
    expect(verified.valid).toBe(true)
    if (!verified.valid) return
    expect(verified.claims.grace).toBeUndefined()
  })
})

describe('a lease for a range of versions', () => {
  it('carries the lowest major when it is above 1, and an open upper bound as OPEN_MAJOR', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const token = await signLease(sampleLease({ major: OPEN_MAJOR, minMajor: 2 }), await importSigningKey(privateJwk), NOW)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.claims.major).toBe(OPEN_MAJOR)
      expect(result.claims.minMajor).toBe(2)
    }
  })

  it('leaves the lowest major out of a lease that has none', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const token = await signLease(sampleLease(), await importSigningKey(privateJwk), NOW)
    const [, payload = ''] = token.split('.')
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
    expect('minMajor' in claims).toBe(false)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid && result.claims.minMajor).toBeUndefined()
  })

  it('refuses a lowest major that is not a positive whole number', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const iat = Math.floor(NOW / 1000)
    const claims = { ...sampleLease(), ttlSeconds: undefined, iss: 'keygrant', iat, exp: iat + 3600, minMajor: 0 }
    const result = await verifyLease(await signRaw(claims, privateJwk), await importVerifyingKey(publicJwk), NOW)
    expect(result).toMatchObject({ valid: false, reason: 'bad-claims' })
  })

  it('keeps OPEN_MAJOR above every major a body may name', () => {
    expect(OPEN_MAJOR).toBeGreaterThan(MAX_MAJOR)
  })
})

describe('the entitlements claim', () => {
  /** A lease's claims as the server would sign them, with `ent` as given (any JSON) or left out (undefined). */
  function rawClaims(ent: unknown): Record<string, unknown> {
    const iat = Math.floor(NOW / 1000)
    const { ttlSeconds: _ttl, ent: _ent, ...rest } = sampleLease()
    return { ...rest, iss: 'keygrant', iat, exp: iat + 3600, ...(ent !== undefined ? { ent } : {}) }
  }

  async function verifiedEnt(ent: unknown): Promise<Entitlements> {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const result = await verifyLease(await signRaw(rawClaims(ent), privateJwk), await importVerifyingKey(publicJwk), NOW)
    if (!result.valid) throw new Error(`expected a valid lease, got ${result.reason}`)
    return result.claims.ent
  }

  it('survives a sign/verify round trip, every kind of value as signed', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const ent = { edition: 'pro', seats: 5, ratio: 0.5, discount: -2, beta: false, label: '' }
    const token = await signLease(sampleLease({ ent }), await importSigningKey(privateJwk), NOW)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid && result.claims.ent).toEqual(ent)
  })

  it('keeps the flag, number and text members of a malformed one and drops the rest, the lease still valid', async () => {
    // A signed lease is the server's word: one bad member must not take the
    // licence away, nor the good members beside it.
    const ent = { nested: { tier: 'gold' }, edition: 'pro', none: null, list: ['a'], seats: 2 }
    expect(await verifiedEnt(ent)).toEqual({ edition: 'pro', seats: 2 })
  })

  it('reads anything but an object as none, never as a refusal', async () => {
    for (const ent of [undefined, null, [], ['pro', true], 'pro', 42, true]) {
      expect(await verifiedEnt(ent), JSON.stringify(ent) ?? 'absent').toEqual({})
    }
  })

  it('takes a member named __proto__ as an entitlement like any other, never as the prototype', async () => {
    const read = await verifiedEnt(JSON.parse('{"__proto__":"pro","seats":1}'))
    expect(Object.keys(read)).toEqual(['__proto__', 'seats'])
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(read, '__proto__')?.value).toBe('pro')
  })

  it('enforces none of the caps the server holds entitlements to: the signature is trusted', async () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, i]))
    const ent = { ...many, ['k'.repeat(40)]: true, long: 'v'.repeat(100) }
    expect(await verifiedEnt(ent)).toEqual(ent)
  })

  it.each<[string, unknown]>([
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
    ['NaN', { seats: Number.NaN }],
    ['a member named __proto__, which signing would silently drop', JSON.parse('{"__proto__":"pro","seats":1}')],
    ['a text with a lone surrogate, which some SDKs cannot read', { edition: 'pro\ud800' }],
    ['a name with a lone low surrogate, which some SDKs cannot read', { ['\udc00edition']: 'pro' }],
    ['a name not in NFC, which Swift takes for its composed twin', { ['e\u0301dition']: 'pro' }],
    ['a name beside its canonical twin, one entitlement to Swift', { ['\u00e9dition']: 'pro', ['e\u0301dition']: 'studio' }],
    ['the Kelvin sign, which NFC makes a K', { ['\u212a']: 1 }],
  ])('is refused when SIGNED as %s: the server signs only what every SDK reads as meant', async (_case, ent) => {
    // A strict reader may refuse a whole lease whose ent is malformed, so the
    // server must never sign one.
    const signingKey = await importSigningKey((await generateKeyPair()).privateJwk)
    await expect(signLease({ ...sampleLease(), ent } as unknown as LeaseInput, signingKey, NOW)).rejects.toThrow()
  })

  it('still signs a text in decomposed form: only names must be in NFC', async () => {
    // A value is compared as it is everywhere, never as a dictionary key, so
    // a text typed on a Mac (NFD) is signed as typed; refusing it would fail
    // every activation and renewal of the keys it rides on.
    const { privateJwk, publicJwk } = await generateKeyPair()
    const ent = { edition: 'Pro e\u0301dition' }
    const token = await signLease(sampleLease({ ent }), await importSigningKey(privateJwk), NOW)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid && result.claims.ent).toEqual(ent)
  })

  it('still signs names and texts beyond ASCII, a surrogate pair included', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const ent = { édition: 'Pro Studio ✓', emoji: '\u{1F3B5}' }
    const token = await signLease(sampleLease({ ent }), await importSigningKey(privateJwk), NOW)
    const result = await verifyLease(token, await importVerifyingKey(publicJwk), NOW)
    expect(result.valid && result.claims.ent).toEqual(ent)
  })

  it('is signed as {} when left out', async () => {
    const { privateJwk, publicJwk } = await generateKeyPair()
    const { ent: _ent, ...withoutEnt } = sampleLease()
    const token = await signLease(withoutEnt as LeaseInput, await importSigningKey(privateJwk), NOW)
    const [, payload = ''] = token.split('.')
    const signed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
    expect(signed.ent).toEqual({})
    expect((await verifyLease(token, await importVerifyingKey(publicJwk), NOW)).valid).toBe(true)
  })
})

describe('fingerprintClaim', () => {
  it('is a stable hex SHA-256 of the fingerprint, never the fingerprint itself', async () => {
    const claim = await fingerprintClaim('machine-guid-1234')
    expect(claim).toMatch(/^[0-9a-f]{64}$/)
    expect(claim).not.toContain('machine-guid-1234')
    expect(await fingerprintClaim('machine-guid-1234')).toBe(claim)
    expect(await fingerprintClaim('machine-guid-5678')).not.toBe(claim)
  })

  it('rides in a lease and is read back from it', async () => {
    const { publicJwk, privateJwk } = await generateKeyPair()
    const fp = await fingerprintClaim('fp-laptop')
    const lease = await signLease(
      { sub: 'K', product: 'p', aid: 'a', fp, model: 'perpetual', lim: 1, major: 1, ent: {}, ttlSeconds: 60 },
      await importSigningKey(privateJwk),
    )
    const result = await verifyLease(lease, await importVerifyingKey(publicJwk))
    expect(result.valid && result.claims.fp).toBe(fp)
  })
})
