/**
 * The licence-file groups: a file's container read for its token
 * (`licenseFileContainers`), a file's token verified, judged and given as a
 * status (`licenseFiles`), and a file given where a lease goes
 * (`filesAsLeases`), after every other group in `conformance/vectors.json`. A
 * group only ever grows at its end.
 */
import { MAX_LICENSE_FILE_BYTES, OPEN_MAJOR, importSigningKey, keyId, licenseFileText, signLicenseFile, type LicenseFileInput } from '@keygrant/shared'
import type { GroupInputs } from '../inputs.js'
import {
  AID,
  HEADER,
  KEY,
  NEXT_PRIVATE_JWK,
  NOW,
  NOW_S,
  OTHER_PRIVATE_JWK,
  PRODUCT,
  TEST_PRIVATE_JWK,
  TEST_PUBLIC_JWK,
  b64url,
  claims,
  clean,
  flipped,
  publicOf,
  segments,
  sign,
  signInput,
  strayBit,
  utf8,
} from './common.js'

const CURRENT = publicOf(TEST_PUBLIC_JWK)
const NEXT = publicOf(NEXT_PRIVATE_JWK)

/** A licence file's header naming `kid`, exactly as the signer writes it. */
const fileHeader = (kid: unknown) => ({ alg: 'EdDSA', typ: 'kglicense+jwt', kid })

/** The major of the file whose payload one vector swaps in under another's signature. */
export const SWAPPED_MAJOR = 9

/** The offline file most vectors start from: Ada's, for majors 2 to 4. */
const OFFLINE: Extract<LicenseFileInput, { kind: 'offline' }> = { kind: 'offline', fid: 'lf_1', sub: KEY, product: PRODUCT, name: 'Ada Lovelace', email: 'ada@example.com', minMajor: 2, major: 4 }
/** A key file: Ada's key, delivered as a file. */
const KEY_FILE: LicenseFileInput = { kind: 'key', fid: 'lf_2', sub: KEY, product: PRODUCT, email: 'ada@example.com' }

/** A file signed by the real signer with `jwk`, naming `jwk`'s key. */
async function signed(input: LicenseFileInput, jwk: { kty: string; crv: string; x: string; d: string } = TEST_PRIVATE_JWK): Promise<string> {
  return signLicenseFile(input, await importSigningKey(jwk), await keyId(publicOf(jwk)), NOW)
}

/** The offline file's claims as the signer writes them, `over` changing or removing (undefined) any. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return clean({ iss: 'keygrant', kind: 'offline', fid: 'lf_1', sub: KEY, product: PRODUCT, name: 'Ada Lovelace', email: 'ada@example.com', major: 4, minMajor: 2, ent: {}, iat: NOW_S, ...over })
}

/** A key id no key of the vectors has: 64 characters, the longest a header may name. */
export const MADE_UP_KID = 'k'.repeat(64)

/** What the licenseFiles vectors are built from: the vectors' keys' ids, the offline file and its segments, and ways to sign others. */
async function fixtures() {
  const current = await keyId(CURRENT)
  const file = await signed(OFFLINE)
  const [h, p, s] = segments(file)
  return {
    current,
    next: await keyId(NEXT),
    file,
    h,
    p,
    s,
    base: { keys: [CURRENT], product: PRODUCT, major: 3, revoked: [] as string[] },
    lease: await sign(claims({ major: 3 }), { ...HEADER, kid: current }),
    byOther: await signed(OFFLINE, OTHER_PRIVATE_JWK),
    /** The offline file's claims changed by `over`, under `header`, signed by the current key. */
    crafted: (over: Record<string, unknown>, header: unknown = fileHeader(current)) => sign(payload(over), header, TEST_PRIVATE_JWK),
    /** The offline file's payload under a header written as `header`, signed by the current key. */
    raw: (header: string) => signInput(`${b64url(utf8(header))}.${p}`),
  }
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>

export async function licenseFiles(): Promise<GroupInputs['licenseFiles'][]> {
  const f = await fixtures()
  return [...(await taken(f)), ...(await refusedForm(f)), ...(await refusedClaims(f))]
}

/** Files read whole: the edges of a range, licensees, the denylist, entitlements, test and key files. */
async function taken({ file, base, crafted }: Fixtures): Promise<GroupInputs['licenseFiles'][]> {
  return [
    { name: 'an offline file, the build inside its range', ...base, token: file },
    { name: 'an offline file, the build at its lowest major', ...base, token: file, major: 2 },
    { name: 'an offline file, the build at its highest major', ...base, token: file, major: 4 },
    { name: 'an offline file, the build below its range: outdated', ...base, token: file, major: 1 },
    { name: 'an offline file, the build above its range: upgrade', ...base, token: file, major: 5 },
    { name: 'an open-ended offline file (OPEN_MAJOR), a far later build', ...base, token: await signed({ ...OFFLINE, major: OPEN_MAJOR }), major: 99_999 },
    { name: 'an offline file with no minMajor: from major 1', ...base, token: await signed({ ...OFFLINE, minMajor: undefined }), major: 1 },
    { name: 'licensed to a name only', ...base, token: await signed({ ...OFFLINE, email: undefined }) },
    { name: 'licensed to an email address only', ...base, token: await signed({ ...OFFLINE, name: undefined }) },
    { name: "another product's file: wrong-product", ...base, token: file, product: 'maindeck' },
    { name: 'its id listed as revoked: revoked-file', ...base, token: file, revoked: ['lf_0', 'lf_1'] },
    { name: 'other ids listed, and its own in another case: matched exactly, taken', ...base, token: file, revoked: ['lf_0', 'LF_1'] },
    { name: 'revoked outranks the version: a listed file the build is above', ...base, token: file, major: 5, revoked: ['lf_1'] },
    { name: 'the product outranks the denylist', ...base, token: file, product: 'maindeck', revoked: ['lf_1'] },
    { name: 'a test licence file', ...base, token: await signed({ ...OFFLINE, test: true }) },
    { name: 'a file granting entitlements', ...base, token: await signed({ ...OFFLINE, ent: { edition: 'pro', seats: 5, cloud: true } }) },
    { name: 'entitlements read leniently: a malformed member dropped', ...base, token: await crafted({ ent: { edition: 'pro', nested: { on: true } } }) },
    { name: 'entitlements that are not an object: none', ...base, token: await crafted({ ent: ['pro'] }) },
    { name: 'entitlements on a file the build is above: none in its status', ...base, token: await signed({ ...OFFLINE, ent: { edition: 'pro' } }), major: 5 },
    { name: 'a key file: taken, whatever the build (its key decides online)', ...base, token: await signed(KEY_FILE), major: 50 },
    { name: "another product's key file: wrong-product", ...base, token: await signed(KEY_FILE), product: 'maindeck' },
    { name: 'a key file listed as revoked: revoked-file', ...base, token: await signed(KEY_FILE), revoked: ['lf_2'] },
    { name: 'a key file carrying versions it should not: not read', ...base, token: await crafted({ kind: 'key', fid: 'lf_2', major: 1 }), major: 7 },
  ]
}

/** Files refused or read by their form: signatures, headers, keys and rotation. */
async function refusedForm({ current, next, file, h, p, s, base, lease, byOther, crafted, raw }: Fixtures): Promise<GroupInputs['licenseFiles'][]> {
  return [
    { name: 'its payload swapped for another file: bad-signature', ...base, token: `${h}.${segments(await signed({ ...OFFLINE, major: SWAPPED_MAJOR }))[1]}.${s}` },
    { name: 'a bit of its signature flipped: bad-signature', ...base, token: `${h}.${p}.${flipped(s, 5)}` },
    { name: 'its signature not canonical base64url: malformed', ...base, token: `${h}.${p}.${strayBit(s)}` },
    { name: 'two parts: malformed', ...base, token: `${h}.${p}` },
    { name: 'four parts: malformed', ...base, token: `${file}.${s}` },
    { name: 'a lease naming its key, given as a file: not-a-license-file', ...base, token: lease, major: 3 },
    { name: 'a lease naming no key, given as a file: not-a-license-file', ...base, token: await sign(claims({ major: 3 })) },
    { name: 'a file header naming no key: not-a-license-file', ...base, token: await crafted({}, { alg: 'EdDSA', typ: 'kglicense+jwt' }) },
    { name: "a file header with its members in another order: not-a-license-file", ...base, token: await raw(`{"typ":"kglicense+jwt","alg":"EdDSA","kid":"${current}"}`) },
    { name: 'a file header with a space: not-a-license-file', ...base, token: await raw(`{"alg":"EdDSA", "typ":"kglicense+jwt","kid":"${current}"}`) },
    { name: 'a file header not canonical base64url: not-a-license-file', ...base, token: `${strayBitOrPad(h)}.${p}.${s}` },
    { name: 'a kid of 65 characters: not-a-license-file', ...base, token: await crafted({}, fileHeader('k'.repeat(65))) },
    { name: 'a kid of 64 characters the set does not hold: unknown-key', ...base, token: await crafted({}, fileHeader(MADE_UP_KID)) },
    { name: 'signed by a key the set does not hold: unknown-key', ...base, token: byOther },
    { name: 'a key the set does not hold, its signature not base64url: malformed first', ...base, token: `${segments(byOther)[0]}.${segments(byOther)[1]}.not+base64url` },
    { name: "a kid naming the set's key in another case: unknown-key", ...base, token: await crafted({}, fileHeader(swapCase(current))) },
    { name: 'rotation: a file the old key signed, the build carrying the new key and the old: taken', ...base, keys: [NEXT, CURRENT], token: file },
    { name: 'rotation: a file the new key signed, the build carrying both: taken', ...base, keys: [CURRENT, NEXT], token: await signed(OFFLINE, NEXT_PRIVATE_JWK) },
    { name: 'rotation: a file the old key signed, the build carrying the new key alone: unknown-key', ...base, keys: [NEXT], token: file },
    { name: 'a file naming the second key but signed by the first: only the named key verifies, bad-signature', ...base, keys: [CURRENT, NEXT], token: await sign(payload(), fileHeader(next)) },
  ]
}

/** Files refused, or read, for their claims and the bytes of their segments; each appended rule at the end. */
async function refusedClaims({ current, h, p, s, base, lease, crafted }: Fixtures): Promise<GroupInputs['licenseFiles'][]> {
  const [leaseHeader, leasePayload, leaseSignature] = segments(lease)
  return [
    { name: 'never expires: an exp claim in the past is not read', ...base, token: await crafted({ exp: NOW_S - 86_400 }) },
    { name: 'a kind the reader does not know: malformed', ...base, token: await crafted({ kind: 'relay' }) },
    { name: 'no file id: malformed', ...base, token: await crafted({ fid: undefined }) },
    { name: 'licensed to no one: malformed', ...base, token: await crafted({ name: undefined, email: undefined }) },
    { name: 'an empty name: malformed', ...base, token: await crafted({ name: '' }) },
    { name: 'an offline file with no major: malformed', ...base, token: await crafted({ major: undefined }) },
    { name: 'an offline file whose major is 0: malformed', ...base, token: await crafted({ major: 0, minMajor: undefined }) },
    { name: 'another issuer: malformed', ...base, token: await crafted({ iss: 'someone' }) },
    { name: 'no iat: malformed', ...base, token: await crafted({ iat: undefined }) },
    { name: 'a payload that is not JSON: malformed', ...base, token: await signInput(`${h}.${b64url(utf8('not json'))}`) },
    { name: 'a payload not canonical base64url: malformed', ...base, token: await signInput(`${h}.${strayBitOrPad(p)}`) },
    { name: 'a payload that is a lease, under a file header: malformed', ...base, token: await sign(claims({ major: 3 }), fileHeader(current)) },
    { name: 'a signature of 63 bytes, canonical: bad-signature, never malformed', ...base, token: `${h}.${p}.${b64url(new Uint8Array(63).fill(7))}` },
    { name: 'an empty signature: bad-signature', ...base, token: `${h}.${p}.` },
    { name: 'a name that is null: malformed (an optional claim is absent or of its type)', ...base, token: await crafted({ name: null }) },
    {
      name: 'a major written 4.0: a whole number, read as 4',
      ...base,
      token: await signInput(`${h}.${b64url(utf8(JSON.stringify(payload()).replace('"major":4,', '"major":4.0,')))}`),
    },
    { name: 'an ent that is null: read as none, never malformed', ...base, token: await crafted({ ent: null }) },
    { name: 'a payload that is not JSON under the original signature: the signature first, bad-signature', ...base, token: `${h}.${b64url(utf8('not json'))}.${s}` },
    { name: "a lease's header with a signature not canonical: the header first, not-a-license-file", ...base, token: `${leaseHeader}.${leasePayload}.${strayBit(leaseSignature)}` },
    { name: 'a kid the set does not hold with an empty signature: the key first, unknown-key', ...base, token: `${segments(await crafted({}, fileHeader(MADE_UP_KID)))[0]}.${p}.` },
    { name: 'a test claim that is not a flag: malformed', ...base, token: await crafted({ test: 'yes' }) },
    { name: 'a negative iat: malformed', ...base, token: await crafted({ iat: -1 }) },
    { name: 'an iat with a fraction: malformed', ...base, token: await crafted({ iat: NOW_S + 0.5 }) },
    { name: 'an empty email: malformed', ...base, token: await crafted({ email: '' }) },
    { name: 'an empty key (sub): malformed', ...base, token: await crafted({ sub: '' }) },
    { name: 'an empty product: malformed', ...base, token: await crafted({ product: '' }) },
    { name: 'an empty file id: malformed', ...base, token: await crafted({ fid: '' }) },
    { name: 'a minMajor of 0: malformed', ...base, token: await crafted({ minMajor: 0 }) },
    { name: 'a payload that is JSON null: malformed', ...base, token: await signInput(`${h}.${b64url(utf8('null'))}`) },
    { name: 'a range the signer would refuse (minMajor 4 above major 2), read as it is: outdated', ...base, token: await crafted({ minMajor: 4, major: 2 }), major: 3 },
  ]
}

/** A segment with a stray bit in its last character, or, when it has none, a padding character: the same bytes, not canonical. */
function strayBitOrPad(segment: string): string {
  return segment.length % 4 === 0 ? `${segment}=` : strayBit(segment)
}

/** A text with each letter's case swapped. */
export function swapCase(text: string): string {
  return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')
}

/** Bytes as a vector carries them: canonical base64url. */
const carried = (bytes: Uint8Array | string) => b64url(typeof bytes === 'string' ? utf8(bytes) : bytes)

export async function licenseFileContainers(): Promise<GroupInputs['licenseFileContainers'][]> {
  const token = await signed(OFFLINE)
  const text = licenseFileText(token)
  // Comment lines and a line break before the token, padded to `size` bytes in all.
  const sized = (size: number) => `${'#'.repeat(size - token.length - 1)}\n${token}`
  return [
    { name: 'a file as the server writes it: notes, then the token', bytes: carried(text) },
    { name: 'with CRLF line endings', bytes: carried(text.replace(/\n/g, '\r\n')) },
    { name: 'after a byte-order mark', bytes: carried(`${String.fromCharCode(0xfeff)}${text}`) },
    { name: 'the token alone, pasted, no line break', bytes: carried(token) },
    { name: 'blank lines, and spaces and tabs around the token', bytes: carried(`\n\n \t${token}\t \n\n`) },
    { name: 'indented comment lines, and a bare #', bytes: carried(`   # licensed to Zo${String.fromCharCode(0xeb)}\n\t#\n#\n${token}\n`) },
    { name: 'a lone carriage return is no line break: the token and a note are one line', bytes: carried(`${token}\r# note`) },
    { name: 'empty', bytes: '' },
    { name: 'notes only, no token', bytes: carried('# KeyGrant license file\n# Product: sluice\n') },
    { name: 'two tokens', bytes: carried(`${token}\n${token}\n`) },
    { name: 'a line of other text beside the token', bytes: carried(`License:\n${token}\n`) },
    { name: 'not UTF-8 (a lone 0xFF byte)', bytes: carried(new Uint8Array([...utf8(`${token}\n# `), 0xff])) },
    { name: 'UTF-16 with its byte-order mark: not UTF-8', bytes: carried(new Uint8Array([0xff, 0xfe, ...[...token].flatMap((c) => [c.charCodeAt(0), 0])])) },
    { name: `exactly ${MAX_LICENSE_FILE_BYTES} bytes: read`, bytes: carried(sized(MAX_LICENSE_FILE_BYTES)) },
    { name: `${MAX_LICENSE_FILE_BYTES + 1} bytes: past the bound, not read`, bytes: carried(sized(MAX_LICENSE_FILE_BYTES + 1)) },
    { name: 'a form feed after the token: only spaces, tabs and CRs are trimmed, so it stays', bytes: carried(`${token}${String.fromCharCode(0x0c)}\n`) },
    { name: 'a no-break space before the token: it stays', bytes: carried(`${String.fromCharCode(0xa0)}${token}\n`) },
    { name: 'a vertical tab after the token: it stays', bytes: carried(`${token}${String.fromCharCode(0x0b)}`) },
    { name: 'two byte-order marks: one is dropped, the other stays', bytes: carried(`${String.fromCharCode(0xfeff, 0xfeff)}${token}\n`) },
  ]
}

export async function filesAsLeases(): Promise<GroupInputs['filesAsLeases'][]> {
  const holder = { key: KEY, activationId: AID, claims: [], canTell: false }
  const base = { now: NOW, product: PRODUCT, major: 2, holder }
  return [
    { name: 'an offline file given as a lease: bad-claims, tampered, and no trial', ...base, token: await signed(OFFLINE) },
    { name: 'a key file given as a lease: bad-claims, tampered, and no trial', ...base, token: await signed(KEY_FILE) },
    {
      name: "a file signed by a key the set does not hold, given as a lease: its header names no lease's key, so bad-signature",
      ...base,
      token: await signed(OFFLINE, OTHER_PRIVATE_JWK),
    },
  ]
}
