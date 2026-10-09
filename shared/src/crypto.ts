import { LeaseClaims, ISSUER, SignableClaims, type LeaseInput } from './lease.js'

/**
 * EdDSA (Ed25519) JWS signing/verification over WebCrypto. Deliberately no JWT
 * library: the whole point of a standard JWS is that ANY consumer can verify a
 * lease with off-the-shelf tooling. This file is the reference signer/verifier.
 *
 * It uses only `globalThis.crypto.subtle` and Ed25519, which Node 22 and any
 * other WebCrypto runtime provide, so this module is runtime-agnostic.
 */

const subtle = crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

const ALG = { name: 'Ed25519' } as const
const JOSE_HEADER = { alg: 'EdDSA', typ: 'JWT' } as const

// ---- base64url ------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode CANONICAL base64url: the URL-safe alphabet, no padding, and nothing
 * the encoder above would not have written (`b64urlEncode` of the result gives
 * the input back). Anything else throws.
 *
 * Strict on purpose. `atob` forgives padding, the standard alphabet and stray
 * bits in the last character, so one signature would have several spellings
 * that all verify, and an SDK in another language with a strict decoder would
 * refuse leases this one accepts. Every lease the server signs is canonical, so
 * only a token nobody issued is refused by this.
 */
function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) throw new Error('not base64url')
  const s = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const bin = atob(s + '='.repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if (b64urlEncode(out) !== input) throw new Error('not canonical base64url')
  return out
}

function jsonToB64url(value: unknown): string {
  return b64urlEncode(enc.encode(JSON.stringify(value)))
}

// ---- keys -----------------------------------------------------------------

export interface KeyPairJwk {
  /** Private key: the signer's alone, never shipped with an app. */
  privateJwk: JsonWebKey
  /** Public key: embedded in or published to clients for offline verify. */
  publicJwk: JsonWebKey
}

/** Generate a fresh Ed25519 keypair as exportable JWKs (one per product). */
export async function generateKeyPair(): Promise<KeyPairJwk> {
  const kp = (await subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const [privateJwk, publicJwk] = (await Promise.all([
    subtle.exportKey('jwk', kp.privateKey),
    subtle.exportKey('jwk', kp.publicKey),
  ])) as [JsonWebKey, JsonWebKey]
  return { privateJwk, publicJwk }
}

export function importSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey('jwk', privateJwk, ALG, false, ['sign'])
}

export function importVerifyingKey(publicJwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey('jwk', publicJwk, ALG, false, ['verify'])
}

/**
 * The `fp` claim for a device fingerprint: hex SHA-256 of it, namespaced. The
 * server signs it into a licence lease; the SDK computes it for the device it
 * runs on and compares. Hashed so the lease, whose payload anyone holding it
 * can read, never carries the fingerprint itself, which a custom fingerprinter
 * may make a machine's raw identifier.
 */
export async function fingerprintClaim(fingerprint: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', enc.encode(`keygrant-fp|${fingerprint}`)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---- sign / verify --------------------------------------------------------

/** Sign a lease into a compact JWS. `now` is injectable for testing. */
export async function signLease(
  input: LeaseInput,
  signingKey: CryptoKey,
  now: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000)
  const { ttlSeconds, ...rest } = input
  // Held to what the server signs (`SignableClaims`): a malformed `ent` throws
  // here, where a verifier would only drop it.
  const claims = SignableClaims.parse({
    ...rest,
    iss: ISSUER,
    iat,
    exp: iat + ttlSeconds,
  })

  const signingInput = `${jsonToB64url(JOSE_HEADER)}.${jsonToB64url(claims)}`
  const sig = new Uint8Array(await subtle.sign(ALG, signingKey, enc.encode(signingInput)))
  return `${signingInput}.${b64urlEncode(sig)}`
}

export type VerifyResult =
  | { valid: true; claims: LeaseClaims }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'bad-claims' | 'expired'; claims?: LeaseClaims }

/**
 * Verify a lease offline. Checks signature first, then shape, then expiry.
 * `now` is injectable for testing. This is the exact logic an SDK, or any
 * third-party verifier, reproduces.
 *
 * The header is not read: the algorithm and the key are the verifier's, never
 * the token's, so a header naming another algorithm or carrying a key of its own
 * changes nothing. The signature and the payload must be canonical base64url
 * (`b64urlDecode`): a signature that is not is `malformed`, a payload that is not
 * is `bad-claims`. Expired is `exp * 1000 < now`, in milliseconds: a lease is
 * still valid during its `exp` second, and not one millisecond after it.
 */
export async function verifyLease(
  token: string,
  verifyingKey: CryptoKey,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { valid: false, reason: 'malformed' }
  const [header, payload, signature] = parts as [string, string, string]

  let signatureOk: boolean
  try {
    signatureOk = await subtle.verify(
      ALG,
      verifyingKey,
      b64urlDecode(signature),
      enc.encode(`${header}.${payload}`),
    )
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!signatureOk) return { valid: false, reason: 'bad-signature' }

  let claims: LeaseClaims
  try {
    claims = LeaseClaims.parse(JSON.parse(dec.decode(b64urlDecode(payload))))
  } catch {
    return { valid: false, reason: 'bad-claims' }
  }

  if (claims.exp * 1000 < now) return { valid: false, reason: 'expired', claims }
  return { valid: true, claims }
}
