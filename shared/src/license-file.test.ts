import { beforeAll, describe, it, expect, vi } from 'vitest'
import { ZodError } from 'zod'
import { generateKeyPair, importSigningKey, importVerifyingKeys, keyId, signLease, verifyLease, type VerifyingKey } from './crypto.js'
import { MAX_MAJOR, OPEN_MAJOR } from './lease.js'
import { LICENSE_FILE_TYP, signLicenseFile, verifyLicenseFile, type LicenseFileInput } from './license-file.js'
import { MAX_LICENSE_FILE_BYTES, licenseFileText, licenseFileToken } from './license-file-text.js'

const NOW = 1_757_000_000_000
const NOW_S = NOW / 1000

type OfflineInput = Extract<LicenseFileInput, { kind: 'offline' }>
type KeyFileInput = Extract<LicenseFileInput, { kind: 'key' }>
const OFFLINE: OfflineInput = { kind: 'offline', fid: 'lf_1', sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD', product: 'sluice', name: 'Ada Lovelace', email: 'ada@example.com', major: 3 }
const KEY_FILE: KeyFileInput = { kind: 'key', fid: 'lf_2', sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD', product: 'sluice', email: 'ada@example.com' }

/** One product key for the suite: the signing key, its id, and the key set of one that verifies with it. */
let s: { key: CryptoKey; kid: string; keys: VerifyingKey[] }

beforeAll(async () => {
  const { privateJwk, publicJwk } = await generateKeyPair()
  s = { key: await importSigningKey(privateJwk), kid: await keyId(publicJwk), keys: await importVerifyingKeys([publicJwk]) }
})

/** A base64url segment's bytes, one character each (no Node Buffer: this suite type-checks under the Workers types too). */
const latin1Of = (segment: string) => atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
const decode = (segment: string) =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(latin1Of(segment), (c) => c.charCodeAt(0)))) as Record<string, unknown>
/** Bytes as a token's segment: base64url, no padding. */
const b64urlOf = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
/** JSON as a token's segment. */
const part = (value: unknown) => b64urlOf(new TextEncoder().encode(JSON.stringify(value)))

/** Whatever a caller hands over as a file's content, typed or not. */
const tokenOf = (content: unknown) => licenseFileToken(content as string)
/** Sign whatever a caller hands over as a file's claims, typed or not. */
const signAny = (input: unknown, kid = s.kid) => signLicenseFile(input as LicenseFileInput, s.key, kid, NOW)
/** A file's claims, verified with the suite's key. */
async function claimsOf(token: string): Promise<Record<string, unknown>> {
  const verified = await verifyLicenseFile(token, s.keys)
  if (!verified.valid) throw new Error(`not valid: ${verified.reason}`)
  return verified.claims
}

describe('signLicenseFile', () => {
  it('signs an offline file with the file header naming its key, and a payload with no lease claims', async () => {
    const token = await signLicenseFile({ ...OFFLINE, minMajor: 2, ent: { edition: 'pro' }, test: true }, s.key, s.kid, NOW)
    const [header, payload] = token.split('.') as [string, string]
    expect(latin1Of(header)).toBe(`{"alg":"EdDSA","typ":"${LICENSE_FILE_TYP}","kid":"${s.kid}"}`)
    // Exactly these members, in this order: no exp, aid, lim, fp or model.
    expect(Object.entries(decode(payload))).toEqual([
      ['iss', 'keygrant'],
      ['kind', 'offline'],
      ['fid', 'lf_1'],
      ['sub', OFFLINE.sub],
      ['product', 'sluice'],
      ['name', 'Ada Lovelace'],
      ['email', 'ada@example.com'],
      ['major', 3],
      ['minMajor', 2],
      ['ent', { edition: 'pro' }],
      ['iat', NOW_S],
      ['test', true],
    ])
    expect(await claimsOf(token)).toMatchObject({ kind: 'offline', minMajor: 2, major: 3 })
  })

  it('signs a key file with neither versions nor entitlements, ent absent rather than empty', async () => {
    const token = await signLicenseFile(KEY_FILE, s.key, s.kid, NOW)
    const claims = { iss: 'keygrant', kind: 'key', fid: 'lf_2', sub: KEY_FILE.sub, product: 'sluice', email: 'ada@example.com', iat: NOW_S }
    expect(decode(token.split('.')[1] as string)).toEqual(claims)
    expect(await claimsOf(token)).toEqual(claims)
  })

  it('writes test only when true, and an offline file with no entitlements as ent {}', async () => {
    const claims = decode((await signLicenseFile({ ...OFFLINE, test: false }, s.key, s.kid, NOW)).split('.')[1] as string)
    expect('test' in claims).toBe(false)
    expect(claims.ent).toEqual({})
    expect('minMajor' in claims).toBe(false)
  })

  it('writes iat as the whole second it was signed in', async () => {
    expect((await claimsOf(await signLicenseFile(OFFLINE, s.key, s.kid, NOW + 999))).iat).toBe(NOW_S)
  })

  it('takes a member given as undefined as one not given, even one a key file may not carry', async () => {
    expect(await claimsOf(await signAny({ ...KEY_FILE, major: undefined, ent: undefined, name: undefined }))).not.toHaveProperty('major')
  })

  it('signs an open-ended range (OPEN_MAJOR), one of a single major, and the highest real major', async () => {
    expect(await claimsOf(await signLicenseFile({ ...OFFLINE, minMajor: 2, major: OPEN_MAJOR }, s.key, s.kid))).toMatchObject({ minMajor: 2, major: OPEN_MAJOR })
    expect(await claimsOf(await signLicenseFile({ ...OFFLINE, minMajor: 3, major: 3 }, s.key, s.kid))).toMatchObject({ minMajor: 3, major: 3 })
    expect(await claimsOf(await signLicenseFile({ ...OFFLINE, minMajor: MAX_MAJOR, major: MAX_MAJOR }, s.key, s.kid))).toMatchObject({ minMajor: MAX_MAJOR, major: MAX_MAJOR })
  })

  const refused: [string, unknown][] = [
    ['no licensee', { ...OFFLINE, name: undefined, email: undefined }],
    ['a blank name', { ...OFFLINE, name: '   ' }],
    ['a blank email', { ...OFFLINE, email: '  ' }],
    ['an empty email', { ...OFFLINE, email: '' }],
    ['a name with a line break', { ...OFFLINE, name: 'Ada\nLovelace' }],
    ['an email with a line break', { ...OFFLINE, email: 'ada@example.com\nbcc: x' }],
    ['a name with a line separator', { ...OFFLINE, name: `Ada${String.fromCharCode(0x2028)}Lovelace` }],
    ['a name with a C1 control', { ...OFFLINE, name: `Ada${String.fromCharCode(0x85)}` }],
    ['a name with a lone surrogate', { ...OFFLINE, name: `Ada${String.fromCharCode(0xd800)}` }],
    ['a name past 128 characters', { ...OFFLINE, name: 'a'.repeat(129) }],
    ['an email past 254 characters', { ...OFFLINE, email: `${'a'.repeat(243)}@example.com` }],
    ['a name that is null', { ...OFFLINE, name: null }],
    ['a test that is not a flag', { ...OFFLINE, test: 'yes' }],
    ['minMajor above major', { ...OFFLINE, minMajor: 4, major: 3 }],
    ['major 0', { ...OFFLINE, major: 0 }],
    ['a fractional major', { ...OFFLINE, major: 2.5 }],
    ['a major past MAX_MAJOR that is not OPEN_MAJOR', { ...OFFLINE, major: MAX_MAJOR + 1 }],
    ['minMajor 0', { ...OFFLINE, minMajor: 0 }],
    ['a fractional minMajor', { ...OFFLINE, minMajor: 2.5 }],
    ['a minMajor past MAX_MAJOR', { ...OFFLINE, minMajor: MAX_MAJOR + 1, major: OPEN_MAJOR }],
    ['a minMajor of OPEN_MAJOR', { ...OFFLINE, minMajor: OPEN_MAJOR, major: OPEN_MAJOR }],
    ['an offline file with no major', { ...OFFLINE, major: undefined }],
    ['a malformed entitlement', { ...OFFLINE, ent: { nested: { on: true } } }],
    ['an entitlement past the caps', { ...OFFLINE, ent: { [`n${'x'.repeat(32)}`]: true } }],
    ['an entitlement named __proto__', { ...OFFLINE, ent: JSON.parse('{"__proto__": true}') as unknown }],
    ['a key file with versions', { ...KEY_FILE, major: 3 }],
    ['a key file with entitlements', { ...KEY_FILE, ent: { edition: 'pro' } }],
    ['a claim the signer does not know', { ...OFFLINE, exp: NOW_S }],
    ['a file id with a dot', { ...OFFLINE, fid: 'lf.1' }],
    ['a file id of 65 characters', { ...OFFLINE, fid: 'f'.repeat(65) }],
    ['an empty file id', { ...OFFLINE, fid: '' }],
    ['an empty key', { ...OFFLINE, sub: '' }],
    ['a key past 120 characters', { ...OFFLINE, sub: 'K'.repeat(121) }],
    ['an empty product', { ...OFFLINE, product: '' }],
    ['a product past 64 characters', { ...OFFLINE, product: 'p'.repeat(65) }],
    ['another kind', { ...OFFLINE, kind: 'relay' }],
  ]
  it.each(refused)('refuses %s', async (_, input) => {
    await expect(signAny(input)).rejects.toBeInstanceOf(ZodError)
  })

  it('refuses a key id that is not one, and signs nothing without one', async () => {
    await expect(signLicenseFile(OFFLINE, s.key, '')).rejects.toThrow(/key id/)
    await expect(signLicenseFile(OFFLINE, s.key, `${s.kid}.`)).rejects.toThrow(/key id/)
    await expect(signLicenseFile(OFFLINE, s.key, 'k'.repeat(65))).rejects.toThrow(/key id/)
  })

  it('takes names, addresses, ids, keys and products at their limits', async () => {
    const longest = { ...OFFLINE, name: 'n'.repeat(128), email: `${'a'.repeat(242)}@example.com`, fid: 'f'.repeat(64), sub: 'K'.repeat(120), product: 'p'.repeat(64) }
    expect(await claimsOf(await signLicenseFile(longest, s.key, s.kid))).toMatchObject({ name: longest.name, email: longest.email, fid: longest.fid, sub: longest.sub, product: longest.product })
  })
})

describe('verifyLicenseFile', () => {
  it('a lease is not a licence file, and a licence file is not a lease, signed by the same key', async () => {
    const lease = await signLease({ sub: OFFLINE.sub, product: 'sluice', aid: 'act_1', model: 'perpetual', lim: 3, major: 3, ent: {}, ttlSeconds: 86_400 }, s.key, NOW, s.kid)
    const file = await signLicenseFile(OFFLINE, s.key, s.kid, NOW)
    expect(await verifyLicenseFile(lease, s.keys)).toEqual({ valid: false, reason: 'not-a-license-file' })
    expect(await verifyLease(file, s.keys, NOW)).toEqual({ valid: false, reason: 'bad-claims' })
  })

  it('verifies a file only by the key it names: another key of the set that did not sign it is a bad signature', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const keys = await importVerifyingKeys([a.publicJwk, b.publicJwk])
    const named = await signLicenseFile(OFFLINE, await importSigningKey(a.privateJwk), await keyId(b.publicJwk), NOW)
    expect(await verifyLicenseFile(named, keys)).toEqual({ valid: false, reason: 'bad-signature' })
    expect(await verifyLicenseFile(named, await importVerifyingKeys([a.publicJwk]))).toEqual({ valid: false, reason: 'unknown-key' })
  })

  it('answers bad-signature, never rejecting, when the verifier throws (a private key given where a public one goes)', async () => {
    const file = await signLicenseFile(OFFLINE, s.key, s.kid, NOW)
    const wrong: VerifyingKey[] = [{ kid: s.kid, key: s.key }]
    expect(await verifyLicenseFile(file, wrong)).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('never asks the verifier about a signature that is not 64 bytes', async () => {
    const [h, p] = (await signLicenseFile(OFFLINE, s.key, s.kid, NOW)).split('.') as [string, string]
    const verify = vi.spyOn(crypto.subtle, 'verify')
    try {
      expect(await verifyLicenseFile(`${h}.${p}.`, s.keys)).toEqual({ valid: false, reason: 'bad-signature' })
      expect(await verifyLicenseFile(`${h}.${p}.${b64urlOf(new Uint8Array(63).fill(7))}`, s.keys)).toEqual({ valid: false, reason: 'bad-signature' })
      expect(verify).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
    }
  })

  it('answers malformed, never rejecting, for a token that is not text', async () => {
    expect(await verifyLicenseFile(42, s.keys)).toEqual({ valid: false, reason: 'malformed' })
    expect(await verifyLicenseFile(null, s.keys)).toEqual({ valid: false, reason: 'malformed' })
  })
})

describe('the licence file container', () => {
  it('writes notes and the token, and reads back exactly the token, as text or as bytes', async () => {
    const token = await signLicenseFile({ ...OFFLINE, minMajor: 2 }, s.key, s.kid, NOW)
    const text = licenseFileText(token)
    expect(text).toBe(
      [
        '# KeyGrant license file',
        '# Product: sluice',
        '# Licensed to: Ada Lovelace <ada@example.com>',
        '# Versions: 2 to 3',
        "# To use it, drop this file onto the app, or open it from the app's license screen.",
        '# Only the last line is read. These notes are not, and changing them changes nothing.',
        token,
        '',
      ].join('\n'),
    )
    expect(licenseFileToken(text)).toBe(token)
    expect(licenseFileToken(new TextEncoder().encode(text))).toBe(token)
    expect(licenseFileToken(new TextEncoder().encode(text).buffer)).toBe(token)
  })

  it("names a key file's key and a test file, and reads every range as a person would", async () => {
    const keyText = licenseFileText(await signLicenseFile({ ...KEY_FILE, test: true }, s.key, s.kid))
    expect(keyText).toContain('# KeyGrant license key file\n')
    expect(keyText).toContain('# Licensed to: <ada@example.com>\n')
    expect(keyText).toContain(`# License key: ${KEY_FILE.sub}\n`)
    expect(keyText).toContain("# A test license, for the developer's own testing.\n")
    expect(keyText).not.toContain('Versions')
    const versions = async (range: { minMajor?: number; major: number }) =>
      /# Versions: (.*)\n/.exec(licenseFileText(await signLicenseFile({ ...OFFLINE, ...range }, s.key, s.kid)))?.[1]
    expect(await versions({ major: 3 })).toBe('1 to 3')
    expect(await versions({ minMajor: 3, major: 3 })).toBe('3')
    expect(await versions({ major: OPEN_MAJOR })).toBe('every version')
    expect(await versions({ minMajor: 2, major: OPEN_MAJOR })).toBe('2 and later')
  })

  it('keeps every note on one line, whatever a claim holds', () => {
    // An unsigned token whose product holds a line break: the writer reads claims, it does not judge them.
    const payload = part({ kind: 'key', product: 'a\nb', sub: 'K\rX', name: `Ada${String.fromCharCode(0x2029)}` })
    const text = licenseFileText(`h.${payload}.s`)
    expect(text.split('\n').filter((line) => !line.startsWith('# ') && line !== '')).toEqual([`h.${payload}.s`])
    expect(text).toContain('# Product: a b\n')
    expect(text).toContain('# License key: K X\n')
    expect(text).toContain('# Licensed to: Ada \n')
  })

  it('refuses to write a file past MAX_LICENSE_FILE_BYTES, which no SDK would read', () => {
    const payload = part({ kind: 'key', product: 'sluice', sub: 'K', email: 'a@b.c' })
    expect(() => licenseFileText(`h.${payload}.${'s'.repeat(MAX_LICENSE_FILE_BYTES)}`)).toThrow(/MAX_LICENSE_FILE_BYTES/)
  })

  it('refuses to write a token whose payload is not a licence file', () => {
    const lease = part({ iss: 'keygrant', model: 'perpetual' })
    expect(() => licenseFileText(`h.${lease}.s`)).toThrow(/not a licence file/)
    expect(() => licenseFileText('no dots')).toThrow()
  })

  it('reads nothing but text, a byte array or an ArrayBuffer, and nothing past the bound', () => {
    expect(tokenOf(42)).toBeNull()
    expect(tokenOf({ token: 'a.b.c' })).toBeNull()
    expect(licenseFileToken('a.b.c')).toBe('a.b.c')
    // A comment line, a line break and the five bytes of the token: exactly the bound, then one byte past it.
    expect(licenseFileToken(`${'#'.repeat(MAX_LICENSE_FILE_BYTES - 6)}\na.b.c`)).toBe('a.b.c')
    expect(licenseFileToken(`${'#'.repeat(MAX_LICENSE_FILE_BYTES - 5)}\na.b.c`)).toBeNull()
    // Past the bound in bytes though not in UTF-16 units: each of these characters is two bytes.
    expect(licenseFileToken(`#${String.fromCharCode(0xe9).repeat(MAX_LICENSE_FILE_BYTES / 2)}\na.b.c`)).toBeNull()
  })

  it('reads a byte array that is a view into a larger buffer by its own bytes only', () => {
    const whole = new TextEncoder().encode('x.y.z\na.b.c\n')
    expect(licenseFileToken(whole.subarray(6))).toBe('a.b.c')
  })
})

describe('a file and meters', () => {
  it('signs no met: an offline file never checks in, so nothing it spends would ever be reported (sdk-contract.md 12.1)', async () => {
    const met = { exports: { left: 5, total: 10, offline: 1 } }
    await expect(signAny({ ...OFFLINE, met })).rejects.toBeInstanceOf(ZodError)
    await expect(signAny({ ...KEY_FILE, met })).rejects.toBeInstanceOf(ZodError)
  })
})
