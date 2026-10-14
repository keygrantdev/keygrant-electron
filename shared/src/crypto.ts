import { LeaseClaims, ISSUER, SignableClaims, type LeaseInput } from './lease.js'
import { ALG, KID, b64urlDecode, b64urlEncode, namedKeyId, signCompact } from './jws.js'

/**
 * EdDSA (Ed25519) JWS signing/verification over WebCrypto. Deliberately no JWT
 * library: the whole point of a standard JWS is that ANY consumer can verify a
 * lease with off-the-shelf tooling. This file is the reference signer/verifier.
 *
 * It uses only WebCrypto's `crypto.subtle` (the global `crypto`) and Ed25519, which Node 22 and any
 * other WebCrypto runtime provide, so this module is runtime-agnostic.
 */

const subtle = crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

const JOSE_HEADER = { alg: 'EdDSA', typ: 'JWT' } as const
/** The header the server writes for a lease that names its key, up to the id (`signLease`, `keyIdOf`). */
const NAMED_HEADER_START = '{"alg":"EdDSA","typ":"JWT","kid":"'

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
 * A public JWK's raw key, checked as every SDK checks one it is given: an
 * object whose `kty` is "OKP" and `crv` "Ed25519"; no private `d`; `use`, when
 * given, "sig"; `key_ops`, when given, a list naming "verify"; `alg`, when
 * given, "EdDSA" or "Ed25519"; and an `x` that, its trailing `=` dropped (a key
 * pasted with padding), is canonical base64url of 32 bytes. Any other member
 * is not read. Throws otherwise. Synchronous, so a configuration can be
 * refused when it is made.
 */
export function publicKeyBytes(publicJwk: JsonWebKey): Uint8Array<ArrayBuffer> {
  const jwk: unknown = publicJwk
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) throw new Error('not a JWK')
  const members = jwk as Record<string, unknown>
  const refused = refusalOf(members)
  if (refused !== null) throw new Error(refused)
  const raw = b64urlDecode(String(members.x).replace(/=+$/, ''))
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes')
  return raw
}

/** Why a JWK's members are not an Ed25519 public key's (`publicKeyBytes`), or null when they are; `x` is decoded after. */
function refusalOf(m: Record<string, unknown>): string | null {
  if (m.kty !== 'OKP' || m.crv !== 'Ed25519') return 'not an Ed25519 key (kty OKP, crv Ed25519)'
  if ('d' in m) return 'this JWK holds a private key: embed the public one'
  if ('use' in m && m.use !== 'sig') return 'its use is not sig'
  if ('key_ops' in m && !namesVerify(m.key_ops)) return 'its key_ops do not include verify'
  if ('alg' in m && m.alg !== 'EdDSA' && m.alg !== 'Ed25519') return 'its alg is not EdDSA'
  return typeof m.x === 'string' ? null : 'it has no x'
}

/** Whether a JWK's `key_ops` is a list naming "verify". */
const namesVerify = (ops: unknown) => Array.isArray(ops) && ops.includes('verify')

/**
 * A public key's id, the `kid` a lease's header names it by: its RFC 7638
 * thumbprint, the base64url (no padding) of the SHA-256 of
 * `{"crv":"Ed25519","kty":"OKP","x":"<x>"}`, with `x` written canonically.
 * Computed from the key itself, so a JWK copied before keys had ids, which
 * carries no `kid` member, has one all the same; a `kid` member a JWK does
 * carry is not read. Throws for a JWK that is not an Ed25519 public key.
 */
export async function keyId(publicJwk: JsonWebKey): Promise<string> {
  const members = `{"crv":"Ed25519","kty":"OKP","x":"${b64urlEncode(publicKeyBytes(publicJwk))}"}`
  return b64urlEncode(new Uint8Array(await subtle.digest('SHA-256', enc.encode(members))))
}

/** One public key of a key set, with its id. */
export interface VerifyingKey {
  kid: string
  key: CryptoKey
}

/**
 * A key set for `verifyLease`: each public JWK imported with its id, in the
 * order given, a key given twice kept once. Throws for an empty set or a JWK
 * that is not an Ed25519 public key.
 */
export async function importVerifyingKeys(publicJwks: readonly JsonWebKey[]): Promise<VerifyingKey[]> {
  if (publicJwks.length === 0) throw new Error('a key set holds at least one public key')
  const keys: VerifyingKey[] = []
  for (const jwk of publicJwks) {
    const kid = await keyId(jwk)
    // Imported as written canonically, so a key pasted with padding imports too.
    const canonical = { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(publicKeyBytes(jwk)) }
    if (!keys.some((k) => k.kid === kid)) keys.push({ kid, key: await importVerifyingKey(canonical) })
  }
  return keys
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

/**
 * Sign a lease into a compact JWS. `now` is injectable for testing. `kid`, the
 * signing key's id (`keyId`), goes in the header, so a verifier holding a key
 * set picks the key it names; without one the header names no key, as every
 * lease signed before key sets did.
 */
export async function signLease(
  input: LeaseInput,
  signingKey: CryptoKey,
  now: number = Date.now(),
  kid?: string,
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

  // Written as `keyIdOf` matches it: JSON.stringify keeps this member order.
  if (kid !== undefined && !KID.test(kid)) throw new Error('a key id is 1 to 64 characters of base64url')
  const header = kid === undefined ? JOSE_HEADER : { ...JOSE_HEADER, kid }
  return signCompact(JSON.stringify(header), JSON.stringify(claims), signingKey)
}

export type VerifyResult =
  | { valid: true; claims: LeaseClaims }
  | {
      valid: false
      reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'bad-claims' | 'expired'
      claims?: LeaseClaims
    }

/**
 * The key a lease's header names (`kid`), or undefined when it names none. A
 * header names a key only when it is, byte for byte, the header the server
 * writes for one: canonical base64url of `{"alg":"EdDSA","typ":"JWT","kid":"<kid>"}`,
 * `<kid>` 1 to 64 characters of the base64url alphabet. Any other header
 * (another order, a space, a member more, a byte-order mark, a kid of other
 * characters, not JSON at all) names no key. The header is matched as bytes,
 * never parsed, so no two JSON readers can disagree about what it names.
 */
function keyIdOf(header: string): string | undefined {
  return namedKeyId(header, NAMED_HEADER_START)
}

/**
 * Whether the signature is one of the set's keys' over `signed`: the key the
 * header names when it names one (`unknown-key` when the set holds no key of
 * that id), else each key in turn. A bare key is a set of one whose id is not
 * known, so the header is not read for it.
 */
async function signatureCheck(
  keys: CryptoKey | readonly VerifyingKey[],
  header: string,
  signature: BufferSource,
  signed: BufferSource,
): Promise<'ok' | 'unknown-key' | 'bad-signature'> {
  if (!isKeySet(keys)) return (await subtle.verify(ALG, keys, signature, signed)) ? 'ok' : 'bad-signature'
  const kid = keyIdOf(header)
  const candidates = kid === undefined ? keys : keys.filter((k) => k.kid === kid)
  if (candidates.length === 0) return 'unknown-key'
  for (const { key } of candidates) {
    if (await subtle.verify(ALG, key, signature, signed)) return 'ok'
  }
  return 'bad-signature'
}

function isKeySet(keys: CryptoKey | readonly VerifyingKey[]): keys is readonly VerifyingKey[] {
  return Array.isArray(keys)
}

/**
 * Verify a lease offline against a key set (`importVerifyingKeys`). Checks the
 * signature first, then shape, then expiry. `now` is injectable for testing.
 * This is the exact logic an SDK, or any third-party verifier, reproduces.
 *
 * The header is read for one thing, the id of the key that signed the lease
 * (`kid`), and only in the exact form the server writes it (`keyIdOf`): a
 * lease naming a key verifies against that key only, and is `unknown-key` when
 * the set holds none of that id; a lease naming none (every lease signed
 * before key sets, and any header of another form) is tried against each key
 * in turn. The
 * algorithm is the verifier's, never the token's, so a header naming another
 * algorithm or carrying a key of its own changes nothing. The signature and the
 * payload must be canonical base64url (`b64urlDecode`): a signature that is not
 * is `malformed`, a payload that is not is `bad-claims`. Expired is
 * `exp * 1000 < now`, in milliseconds: a lease is still valid during its `exp`
 * second, and not one millisecond after it.
 *
 * Given a bare key instead of a set, its id is not known, and the header is not
 * read at all: one key, as a verifier held before key sets.
 */
export async function verifyLease(
  token: string,
  keys: CryptoKey | readonly VerifyingKey[],
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { valid: false, reason: 'malformed' }
  const [header, payload, signature] = parts as [string, string, string]

  let checked: 'ok' | 'unknown-key' | 'bad-signature'
  try {
    checked = await signatureCheck(keys, header, b64urlDecode(signature), enc.encode(`${header}.${payload}`))
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (checked !== 'ok') return { valid: false, reason: checked }

  let claims: LeaseClaims
  try {
    claims = LeaseClaims.parse(JSON.parse(dec.decode(b64urlDecode(payload))))
  } catch {
    return { valid: false, reason: 'bad-claims' }
  }

  if (claims.exp * 1000 < now) return { valid: false, reason: 'expired', claims }
  return { valid: true, claims }
}
