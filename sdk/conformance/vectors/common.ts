/**
 * What every vector group shares: the TEST-ONLY signing keys, how a lease is
 * signed (any payload, valid claims or not), and the fixed moment, licence and
 * device every vector is built around. Everything is deterministic: Ed25519
 * signatures are, and every time is fixed.
 */
import { fingerprintClaim } from '@keygrant/shared'

/** TEST ONLY. Never a product's key: it exists to sign the vectors. */
export const TEST_PRIVATE_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: '7M0XqcS5ikXwkEvt2VKkfVK9x-LxF_N523of445LXxk',
  x: 'Ohg4h8SrYQ0m1su_zVacJLLwf_6rNsvOtV5oWY6CzJs',
} as const
export const TEST_PUBLIC_JWK = { kty: 'OKP', crv: 'Ed25519', x: TEST_PRIVATE_JWK.x } as const

/** TEST ONLY, and not the vectors' key: what a lease signed by someone else is signed with. */
export const OTHER_PRIVATE_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: '6KkDaB_Hlw_M0UsUJWd6-mlqvpUoxo6FKy2haiOBtOk',
  x: 'Tu1saauBwIOqXNkvG9zbjbBgRogtgu6I0Hd1B7MSnv8',
} as const

/**
 * TEST ONLY: the next key a product stages beside the vectors' key, so a key set
 * holds two (the `keySets` group).
 */
export const NEXT_PRIVATE_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: 'ck0GOFUAjKOmsmx0HqS_sGocjAfiBciYuotbAtDHTlA',
  x: '5x8AEh6i8eeBZ4Pxc0e3J9wvaG_a13dwSwE-Ii1otps',
} as const

/** A private JWK's public half, as an app embeds it. */
export const publicOf = (jwk: { kty: string; crv: string; x: string }) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x })

const enc = new TextEncoder()
/** UTF-8 of a text. */
export const utf8 = (text: string) => enc.encode(text)
export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
/** A JSON value as a token's segment. */
export const part = (value: unknown) => b64url(utf8(JSON.stringify(value)))
export const HEADER = { alg: 'EdDSA', typ: 'JWT' }

/** Sign `header.payload` exactly as given, with the vectors' key or another. */
export async function signInput(input: string, jwk: JsonWebKey = TEST_PRIVATE_JWK): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(input)))
  return `${input}.${b64url(sig)}`
}

/** Sign any payload, valid claims or not, as the server would sign a lease. */
export function sign(payload: unknown, header: unknown = HEADER, jwk?: JsonWebKey): Promise<string> {
  return signInput(`${part(header)}.${part(payload)}`, jwk)
}

/** A token's three segments. */
export function segments(token: string): [string, string, string] {
  return token.split('.') as [string, string, string]
}

/** A signature segment with one bit of its `byte` changed (`bit`): the same length, canonical, and wrong. */
export function flipped(signature: string, byte: number, bit = 0x01): string {
  const bytes = Buffer.from(signature, 'base64url')
  bytes[byte] = (bytes[byte] ?? 0) ^ bit
  return b64url(bytes)
}

/** A base64url segment with a stray bit in its last character: the same bytes, not canonical. */
export function strayBit(segment: string): string {
  if (segment.length % 4 === 0) throw new Error('a whole-block segment has no unused bits')
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = ALPHABET.indexOf(segment.slice(-1))
  return segment.slice(0, -1) + ALPHABET[last | 1]
}

/** Drop `undefined` members, which JSON cannot say, so a missing field is simply absent. */
export function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// A fixed moment: every lease is signed and judged against it.
export const NOW_S = 1_790_000_000 // 2026-09-21T13:33:20Z
export const NOW = NOW_S * 1000
export const DAY = 86_400
export const DAY_MS = DAY * 1000
export const HOUR_MS = 3_600_000

export const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
export const AID = 'act_1'
export const PRODUCT = 'sluice'

/** A licence lease's claims, valid by default; `over` changes or removes (undefined) any of them. */
export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return clean({
    iss: 'keygrant',
    sub: KEY,
    product: PRODUCT,
    aid: AID,
    model: 'perpetual',
    lim: 3,
    major: 3,
    ent: {},
    iat: NOW_S - DAY,
    exp: NOW_S + 29 * DAY,
    ...over,
  })
}

/** The devices the vectors know: this one (its own fingerprint and the host-name one it had), and another. */
export interface Context {
  own: string
  alternate: string
  stranger: string
  ownClaim: string
  altClaim: string
  strangerClaim: string
}

export async function context(): Promise<Context> {
  const own = 'fingerprint-machine-own'
  const alternate = 'fingerprint-hostname-alt'
  const stranger = 'fingerprint-someone-else'
  return {
    own,
    alternate,
    stranger,
    ownClaim: await fingerprintClaim(own),
    altClaim: await fingerprintClaim(alternate),
    strangerClaim: await fingerprintClaim(stranger),
  }
}
