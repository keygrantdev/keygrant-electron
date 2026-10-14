import { z } from 'zod'
import { ISSUER, MAX_LICENSE_KEY, MAX_MAJOR, MAX_PRODUCT_SLUG, OPEN_MAJOR, SettableEntitlements, entitlementsOf } from './lease.js'
import type { VerifyingKey } from './crypto.js'
import { ALG, KID, b64urlDecode, namedKeyId, signCompact } from './jws.js'
import { CONTROL } from './text.js'

/**
 * A licence file: a signed token a buyer is sent as a file, that an app takes
 * by drag-and-drop and verifies offline. One format, two kinds:
 *
 * - `key`: it carries the licence key, and the app activates online with it
 *   exactly as with a typed key (seats, revocation and refunds as usual). Only
 *   the delivery differs.
 * - `offline`: a lease that never expires and is bound to no device, for
 *   machines that never go online. It has no seat limit and cannot be revoked:
 *   a leaked file works until an app update lists its id as revoked, and a
 *   refund cannot take it back.
 *
 * The token is a compact JWS signed with the product's Ed25519 key, as a lease
 * is, but it can never be taken for one, either way: its header is exactly
 * `{"alg":"EdDSA","typ":"kglicense+jwt","kid":"<kid>"}` (explicit typing, RFC
 * 8725 section 3.11), which is part of what is signed, and its claims carry
 * none of the `aid`, `lim`, `exp` and `model` every lease reader requires.
 */

/** The kinds of licence file. */
export const LICENSE_FILE_KINDS = ['key', 'offline'] as const
export type LicenseFileKind = (typeof LICENSE_FILE_KINDS)[number]

/** The header's `typ`: a licence file, never a lease (whose `typ` is `JWT`). */
export const LICENSE_FILE_TYP = 'kglicense+jwt'

/** The file's extension, for an app's open dialog and drop filter. */
export const LICENSE_FILE_EXTENSION = '.kglicense'

/**
 * The media type of a licence file attached to an email. A vendor type, so a
 * mail client hands it over as a download, byte for byte, where `text/plain`
 * may be shown inline or have its line endings and charset rewritten.
 */
export const LICENSE_FILE_MEDIA_TYPE = 'application/vnd.keygrant.license'

/** A licence file's header, up to its key id, as the signer writes it and the verifier matches it (`namedKeyId`). */
const FILE_HEADER_START = `{"alg":"EdDSA","typ":"${LICENSE_FILE_TYP}","kid":"`

/** An Ed25519 signature's length, in bytes. */
const SIGNATURE_BYTES = 64

const enc = new TextEncoder()
const dec = new TextDecoder()

const NumericDate = z.number().int().nonnegative()

/** What every licence file says, whatever its kind, as a verifier reads it. */
const FileBase = {
  iss: z.literal(ISSUER),
  /** The file's id: what an app's `revokedLicenseFiles` names it by. Kept when the file is signed again. */
  fid: z.string().min(1),
  /** The licence key: the one a key file activates with; the one an offline file records. */
  sub: z.string().min(1),
  /** The product slug. */
  product: z.string().min(1),
  /** Who it is licensed to: a name, an email address, or both (at least one). */
  name: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  /** When it was signed (seconds). It never expires. */
  iat: NumericDate,
  /** A test licence's file. Absent means a real one. */
  test: z.boolean().optional(),
}

const KeyFileClaims = z.object({ ...FileBase, kind: z.literal('key') })

const OfflineFileClaims = z.object({
  ...FileBase,
  kind: z.literal('offline'),
  /** Highest app major it covers; `OPEN_MAJOR` when it has no upper bound. Required. */
  major: z.number().int().positive(),
  /** Lowest app major it covers; absent means 1. */
  minMajor: z.number().int().positive().optional(),
  /** Entitlements, read leniently as a lease's (`entitlementsOf`). */
  ent: z.unknown().transform(entitlementsOf),
})

/**
 * A licence file's claims as a verifier reads them. Unknown claims are
 * ignored; a key file's versions and entitlements, which it never carries, are
 * not read; `ent` is read leniently. A file names who it is licensed to. An
 * optional claim is absent or of its type: `null` is not absent (but for
 * `ent`, which reads anything that is not an object as none).
 */
export const LicenseFileClaims = z
  .discriminatedUnion('kind', [KeyFileClaims, OfflineFileClaims])
  .refine((c) => c.name !== undefined || c.email !== undefined, 'a licence file names who it is licensed to')

export type LicenseFileClaims = z.infer<typeof LicenseFileClaims>

/** Half of a surrogate pair standing alone, which JSON writes as an escape some SDKs refuse. */
const LONE_SURROGATE = /\p{Cs}/u

/** A licensee's name or address as the signer takes it: not blank, at most `max` UTF-16 units, no controls, whole characters. */
const Licensee = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => text.trim().length > 0, 'not blank')
    .refine((text) => !CONTROL.test(text) && !LONE_SURROGATE.test(text), 'no control characters or lone surrogates')

/** A major as an offline file's range takes it: a real major, or `OPEN_MAJOR` for no upper bound. */
const Major = z.number().int().min(1).refine((major) => major <= MAX_MAJOR || major === OPEN_MAJOR, 'a major of 1 to MAX_MAJOR, or OPEN_MAJOR')

const SignableBase = {
  fid: z.string().regex(KID, 'a file id is 1 to 64 characters of base64url'),
  sub: z.string().min(1).max(MAX_LICENSE_KEY),
  product: z.string().min(1).max(MAX_PRODUCT_SLUG),
  name: Licensee(128).optional(),
  email: Licensee(254).optional(),
  test: z.boolean().optional(),
}

const SignableKeyFile = z.object({ ...SignableBase, kind: z.literal('key') }).strict()

const SignableOfflineFile = z
  .object({
    ...SignableBase,
    kind: z.literal('offline'),
    major: Major,
    minMajor: z.number().int().min(1).max(MAX_MAJOR).optional(),
    ent: SettableEntitlements.optional(),
  })
  .strict()

/**
 * What `signLicenseFile` signs, held strictly: a key file carries no versions
 * and no entitlements (the server decides them at activation, and a key's range
 * can change after its file was made); an offline file says the versions it
 * covers, low to high, and entitlements as a licence model sets them
 * (`SettableEntitlements`); a file names who it is licensed to.
 */
export const SignableLicenseFile = z
  .discriminatedUnion('kind', [SignableKeyFile, SignableOfflineFile])
  .refine((f) => f.name !== undefined || f.email !== undefined, 'a licence file names who it is licensed to')
  .refine((f) => f.kind === 'key' || (f.minMajor ?? 1) <= f.major, 'minMajor above major covers nothing')

/** What `signLicenseFile` takes: the file's claims but `iss` and `iat`. */
export type LicenseFileInput = z.input<typeof SignableLicenseFile>

/** A file's claims in the order the contract's table lists them, `test` only when true. */
function claimsOf(file: z.infer<typeof SignableLicenseFile>, iat: number): Record<string, unknown> {
  const versions =
    file.kind === 'offline'
      ? { major: file.major, ...(file.minMajor !== undefined ? { minMajor: file.minMajor } : {}), ent: file.ent ?? {} }
      : {}
  return {
    iss: ISSUER,
    kind: file.kind,
    fid: file.fid,
    sub: file.sub,
    product: file.product,
    ...(file.name !== undefined ? { name: file.name } : {}),
    ...(file.email !== undefined ? { email: file.email } : {}),
    ...versions,
    iat,
    ...(file.test === true ? { test: true } : {}),
  }
}

/**
 * Sign a licence file's token. `kid`, the signing key's id (`keyId`), is
 * required: a file is verified by the key it names, and only by it. Throws for
 * a claim the signer does not sign (`SignableLicenseFile`) or a key id that is
 * not one. A member given as undefined is one not given. `now` is injectable
 * for testing.
 */
export async function signLicenseFile(
  input: LicenseFileInput,
  signingKey: CryptoKey,
  kid: string,
  now: number = Date.now(),
): Promise<string> {
  if (!KID.test(kid)) throw new Error('a key id is 1 to 64 characters of base64url')
  const file = SignableLicenseFile.parse(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)))
  const claims = claimsOf(file, Math.floor(now / 1000))
  return signCompact(`${FILE_HEADER_START}${kid}"}`, JSON.stringify(claims), signingKey)
}

/**
 * Whether `sig` is `key`'s Ed25519 signature over `signed`: 64 bytes, and
 * verified. A verifier that throws is no signature, so verifying never rejects.
 */
async function signedBy(key: CryptoKey, sig: Uint8Array<ArrayBuffer>, signed: string): Promise<boolean> {
  if (sig.length !== SIGNATURE_BYTES) return false
  try {
    return await crypto.subtle.verify(ALG, key, sig, enc.encode(signed))
  } catch {
    return false
  }
}

export type LicenseFileVerifyResult =
  | { valid: true; claims: LicenseFileClaims }
  | { valid: false; reason: 'malformed' | 'not-a-license-file' | 'unknown-key' | 'bad-signature' | 'bad-claims' }

/**
 * Verify a licence file's token offline against a key set
 * (`importVerifyingKeys`), in this order: text of three parts (`malformed`);
 * a licence file's header (`not-a-license-file`: a lease, or any other token);
 * the signature canonical base64url (`malformed`); the key it names held by
 * the set (`unknown-key`); a signature of 64 bytes, verified by that key alone
 * (`bad-signature`); the payload canonical base64url of JSON matching
 * `LicenseFileClaims` (`bad-claims`). It never expires, so there is no time to
 * judge it at.
 */
export async function verifyLicenseFile(token: unknown, keys: readonly VerifyingKey[]): Promise<LicenseFileVerifyResult> {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return { valid: false, reason: 'malformed' }
  const [header, payload, signature] = parts as [string, string, string]
  const kid = namedKeyId(header, FILE_HEADER_START)
  if (kid === undefined) return { valid: false, reason: 'not-a-license-file' }

  let sig: Uint8Array<ArrayBuffer>
  try {
    sig = b64urlDecode(signature)
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  const named = keys.find((k) => k.kid === kid)
  if (named === undefined) return { valid: false, reason: 'unknown-key' }
  if (!(await signedBy(named.key, sig, `${header}.${payload}`))) return { valid: false, reason: 'bad-signature' }

  try {
    return { valid: true, claims: LicenseFileClaims.parse(JSON.parse(dec.decode(b64urlDecode(payload)))) }
  } catch {
    return { valid: false, reason: 'bad-claims' }
  }
}
