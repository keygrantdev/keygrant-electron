/**
 * The `leases` group: a licence lease verified (`verifyLease`) and judged for this product, build
 * and holder (offline.ts `checkLease`). A group only ever grows at its end, so no vector an SDK
 * already answers moves.
 */
import { OPEN_MAJOR, keyId } from '@keygrant/shared'
import type { LeaseHolder } from '../../src/offline.js'
import type { LeaseVector } from '../inputs.js'
import {
  AID,
  DAY,
  HEADER,
  KEY,
  NEXT_PRIVATE_JWK,
  NOW,
  NOW_S,
  OTHER_PRIVATE_JWK,
  PRODUCT,
  TEST_PUBLIC_JWK,
  b64url,
  claims,
  flipped,
  part,
  segments,
  sign,
  signInput,
  strayBit,
  utf8,
  type Context,
} from './common.js'

/** A token, and how it is judged when not as usual (now NOW, this product, build 1, this holder). */
export interface LeaseCase {
  name: string
  token: string
  product?: string
  major?: number
  holder?: Partial<LeaseHolder>
  now?: number
}

export async function leases(ctx: Context): Promise<LeaseVector[]> {
  const valid = await sign(claims())
  const cases = [
    ...(await validity(valid)),
    ...(await signatures(valid)),
    ...(await encodings(valid)),
    ...(await headers(valid)),
    ...(await refusedClaims(ctx)),
    ...(await whose(ctx)),
    ...(await versions(valid)),
    ...(await precedence(ctx)),
    ...(await verifyOrder()),
    ...(await moreRefusedClaims()),
    ...(await exactMatching(ctx)),
    ...(await entitlements()),
    ...(await keysNamed()),
  ]
  return leaseVectors(cases, ctx)
}

/** Each case as a vector, judged as usual where it does not say otherwise. */
export function leaseVectors(cases: LeaseCase[], ctx: Context): LeaseVector[] {
  return cases.map((c) => ({
    name: c.name,
    token: c.token,
    now: c.now ?? NOW,
    product: c.product ?? PRODUCT,
    major: c.major ?? 1,
    holder: {
      key: c.holder?.key ?? KEY,
      activationId: c.holder?.activationId ?? AID,
      claims: c.holder?.claims ?? [ctx.ownClaim, ctx.altClaim],
      canTell: c.holder?.canTell ?? true,
    },
  }))
}

async function validity(valid: string): Promise<LeaseCase[]> {
  return [
    { name: 'a valid perpetual lease', token: valid },
    { name: 'a valid test lease', token: await sign(claims({ test: true })) },
    { name: 'a lease in its grace window', token: await sign(claims({ grace: true, model: 'subscription' })) },
    { name: 'a lease past its end', token: await sign(claims({ exp: NOW_S - 1 })) },
    { name: 'a lease ending exactly now is still valid', token: await sign(claims({ exp: NOW_S })) },
    { name: 'a lease one millisecond past its end second', token: await sign(claims({ exp: NOW_S })), now: NOW + 1 },
    { name: 'a lease signed a day in the future (the device clock is behind)', token: await sign(claims({ iat: NOW_S + DAY })) },
  ]
}

async function signatures(valid: string): Promise<LeaseCase[]> {
  const [validHeader, validPayload, validSig] = segments(valid)
  const named = { ...HEADER, jwk: { kty: 'OKP', crv: 'Ed25519', x: OTHER_PRIVATE_JWK.x } }
  return [
    { name: 'a lease whose signature has one bit changed', token: `${validHeader}.${validPayload}.${flipped(validSig, 32)}` },
    { name: 'the payload changed under the original signature', token: `${validHeader}.${part(claims({ major: OPEN_MAJOR }))}.${validSig}` },
    { name: 'a lease signed by another key', token: await sign(claims(), HEADER, OTHER_PRIVATE_JWK) },
    { name: 'a lease signed by another key that names it in the header', token: await sign(claims(), named, OTHER_PRIVATE_JWK) },
    { name: 'an unsigned lease (alg none, empty signature)', token: `${part({ alg: 'none', typ: 'JWT' })}.${validPayload}.` },
  ]
}

async function encodings(valid: string): Promise<LeaseCase[]> {
  const [validHeader, validPayload, validSig] = segments(valid)
  // A lease whose signature has a `-` or `_`, for the standard-alphabet case.
  let urlSafe = valid
  for (let n = 0; !/[-_]/.test(segments(urlSafe)[2]); n++) urlSafe = await sign(claims({ ent: { n } }))
  const [usHeader, usPayload, usSig] = segments(urlSafe)
  // A payload whose base64url does not end on a whole block, so it has bits to spare.
  let spare = claims()
  for (let n = 0; part(spare).length % 4 === 0; n++) spare = claims({ ent: { pad: 'x'.repeat(n + 1) } })
  const sparePayload = part(spare)
  return [
    { name: 'a token with two parts', token: `${validHeader}.${validPayload}` },
    { name: 'a token with four parts', token: `${valid}.extra` },
    { name: 'a signature that is not base64url', token: `${validHeader}.${validPayload}.!!!` },
    { name: 'a signature with a stray bit in its last character', token: `${validHeader}.${validPayload}.${strayBit(validSig)}` },
    { name: 'a padded signature', token: `${valid}==` },
    { name: 'a signature in the standard alphabet', token: `${usHeader}.${usPayload}.${usSig.replace(/-/g, '+').replace(/_/g, '/')}` },
    { name: 'a payload with a stray bit, signed as it is', token: await signInput(`${part(HEADER)}.${strayBit(sparePayload)}`) },
    { name: 'a padded payload, signed as it is', token: await signInput(`${part(HEADER)}.${validPayload}=`) },
  ]
}

/** The header is not read. */
async function headers(valid: string): Promise<LeaseCase[]> {
  const [, validPayload] = segments(valid)
  return [
    { name: 'a header naming no algorithm, over a good signature', token: await sign(claims(), { alg: 'none' }) },
    { name: 'a header naming HS256, over a good signature', token: await sign(claims(), { alg: 'HS256', typ: 'JWT' }) },
    { name: 'a header that is not JSON, over a good signature', token: await signInput(`${b64url(utf8('not json'))}.${validPayload}`) },
    { name: 'a header that is not base64url, over a good signature', token: await signInput(`%%%.${validPayload}`) },
  ]
}

/**
 * Claims the schema refuses, and some it takes: a device claim of 128 characters, and the three
 * malformed entitlements, which are dropped rather than refusing the lease (`entitlements` below
 * has the rest).
 */
async function refusedClaims(ctx: Context): Promise<LeaseCase[]> {
  return [
    { name: 'claims from another issuer', token: await sign(claims({ iss: 'someone' })) },
    { name: 'a lease with no sub', token: await sign(claims({ sub: undefined })) },
    { name: 'an empty sub', token: await sign(claims({ sub: '' })) },
    { name: 'no product', token: await sign(claims({ product: undefined })) },
    { name: 'an empty activation id', token: await sign(claims({ aid: '' })) },
    { name: 'a fractional expiry', token: await sign(claims({ exp: NOW_S + 0.5 })) },
    { name: 'a negative expiry', token: await sign(claims({ exp: -1 })) },
    { name: 'an expiry that is a string', token: await sign(claims({ exp: String(NOW_S + DAY) })) },
    { name: 'no expiry', token: await sign(claims({ exp: undefined })) },
    { name: 'no signing time', token: await sign(claims({ iat: undefined })) },
    { name: 'an unknown licence model', token: await sign(claims({ model: 'lifetime' })) },
    { name: 'a device limit of zero', token: await sign(claims({ lim: 0 })) },
    { name: 'a fractional device limit', token: await sign(claims({ lim: 1.5 })) },
    { name: 'a negative major', token: await sign(claims({ major: -1 })) },
    { name: 'a fractional major', token: await sign(claims({ major: 1.5 })) },
    { name: 'a lowest version of zero', token: await sign(claims({ minMajor: 0 })) },
    { name: 'an empty device claim', token: await sign(claims({ fp: '', fpk: 'machine' })) },
    { name: 'a device claim of 129 characters', token: await sign(claims({ fp: 'f'.repeat(129), fpk: 'machine' })) },
    { name: 'a device claim of 128 characters', token: await sign(claims({ fp: 'f'.repeat(128), fpk: 'hostname' })) },
    { name: 'a device kind in capitals', token: await sign(claims({ fp: ctx.ownClaim, fpk: 'MACHINE' })) },
    { name: 'an entitlement that is an object', token: await sign(claims({ ent: { a: { b: 1 } } })) },
    { name: 'an entitlement that is null', token: await sign(claims({ ent: { a: null } })) },
    { name: 'entitlements that are a list', token: await sign(claims({ ent: [] })) },
    { name: 'a test flag that is a string', token: await sign(claims({ test: 'true' })) },
    { name: 'a grace flag that is a number', token: await sign(claims({ grace: 1 })) },
    { name: 'a payload that is not JSON', token: await signInput(`${part(HEADER)}.${b64url(utf8('not json'))}`) },
    { name: 'a payload that is a list', token: await sign([]) },
    { name: 'a payload that is null', token: await sign(null) },
    { name: 'a payload that is a number', token: await sign(42) },
  ]
}

/** Whose lease it is: this product, key, activation and device. */
async function whose(ctx: Context): Promise<LeaseCase[]> {
  const { ownClaim, altClaim, strangerClaim } = ctx
  return [
    { name: 'a lease for another product', token: await sign(claims({ product: 'maindeck' })) },
    { name: 'a lease for another key', token: await sign(claims({ sub: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ' })) },
    { name: 'the same key in another case', token: await sign(claims({ sub: KEY.toLowerCase() })) },
    { name: 'a lease for another activation', token: await sign(claims({ aid: 'act_2' })) },
    { name: 'a machine-held lease for another device', token: await sign(claims({ fp: strangerClaim, fpk: 'machine' })) },
    {
      name: 'a machine-held lease for another device, on a run that cannot tell',
      token: await sign(claims({ fp: strangerClaim, fpk: 'machine' })),
      holder: { canTell: false },
    },
    { name: 'a host-name lease for another device', token: await sign(claims({ fp: strangerClaim, fpk: 'hostname' })) },
    { name: 'a lease with fp and no kind', token: await sign(claims({ fp: strangerClaim })) },
    { name: 'a machine-held lease for this device', token: await sign(claims({ fp: ownClaim, fpk: 'machine' })) },
    { name: "a machine-held lease for this device's alternate", token: await sign(claims({ fp: altClaim, fpk: 'machine' })) },
  ]
}

async function versions(valid: string): Promise<LeaseCase[]> {
  const open = claims({ major: OPEN_MAJOR, upgradeUntil: NOW_S + 90 * DAY })
  return [
    { name: "a build older than the key's lowest version", token: await sign(claims({ minMajor: 2 })), major: 1 },
    { name: "a build at the key's lowest version", token: await sign(claims({ minMajor: 2 })), major: 2 },
    { name: 'a build newer than the key covers', token: valid, major: 4 },
    { name: "a build at the key's highest version", token: valid, major: 3 },
    { name: 'build 0 with no lowest version', token: valid, major: 0 },
    { name: 'a lease with no major claim covers no build', token: await sign(claims({ major: undefined })) },
    { name: 'an open-ended key', token: await sign(open), major: 41 },
    { name: 'claims it does not know are ignored', token: await sign(claims({ somethingNew: 'x', ent: { pro: true, seats: 5, tier: 'gold' } })) },
  ]
}

/** Which refusal wins when several apply. */
async function precedence(ctx: Context): Promise<LeaseCase[]> {
  const { strangerClaim } = ctx
  const another = { fp: strangerClaim, fpk: 'machine' }
  return [
    { name: 'expired, and for another product', token: await sign(claims({ product: 'maindeck', exp: NOW_S - 1 })) },
    { name: 'for another product and another device', token: await sign(claims({ product: 'maindeck', ...another })) },
    { name: 'for another key on another device', token: await sign(claims({ sub: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ', ...another })) },
    { name: 'another device, and a build newer than covered', token: await sign(claims(another)), major: 4 },
    { name: 'another device, and a build older than covered', token: await sign(claims({ ...another, minMajor: 2 })), major: 1 },
    { name: 'a range upside down (lowest 5, highest 3), build 4', token: await sign(claims({ minMajor: 5 })), major: 4 },
    { name: 'a range upside down (lowest 5, highest 3), build 6', token: await sign(claims({ minMajor: 5 })), major: 6 },
  ]
}

/**
 * Which check of verifying comes first: the signature's encoding, then the
 * signature, then the claims. A changed signature says nothing of the claims
 * (no claims, even expired ones); a signature that is not canonical is
 * malformed whatever the payload.
 */
async function verifyOrder(): Promise<LeaseCase[]> {
  const [eHeader, ePayload, eSig] = segments(await sign(claims({ exp: NOW_S - 1 })))
  const [fHeader, fPayload, fSig] = segments(await sign(claims({ iss: 'someone' })))
  const [nHeader, nPayload, nSig] = segments(await signInput(`${part(HEADER)}.${b64url(utf8('not json'))}`))
  // A payload with a `-` or `_` in its base64url, spelled in the standard alphabet and signed as it is.
  let urlSafe = part(claims())
  for (let n = 0; !/[-_]/.test(urlSafe); n++) urlSafe = part(claims({ ent: { q: '?'.repeat(n + 1) } }))
  const standard = urlSafe.replace(/-/g, '+').replace(/_/g, '/')
  return [
    { name: 'a changed signature over expired claims: bad-signature, with no claims', token: `${eHeader}.${ePayload}.${flipped(eSig, 32)}` },
    { name: 'a changed signature over claims the schema refuses: bad-signature', token: `${fHeader}.${fPayload}.${flipped(fSig, 32)}` },
    { name: 'a signature with a stray bit over a payload that is not JSON: malformed', token: `${nHeader}.${nPayload}.${strayBit(nSig)}` },
    { name: 'a payload in the standard alphabet, signed as it is: bad-claims', token: await signInput(`${part(HEADER)}.${standard}`) },
  ]
}

/** More claims the schema refuses, and an absent `ent` it reads as `{}`. */
async function moreRefusedClaims(): Promise<LeaseCase[]> {
  return [
    { name: 'a signing time of 1.5', token: await sign(claims({ iat: 1.5 })) },
    { name: 'a negative signing time', token: await sign(claims({ iat: -1 })) },
    { name: 'an upgrade window ending at 1.5', token: await sign(claims({ upgradeUntil: 1.5 })) },
    { name: 'an upgrade window ending before the epoch', token: await sign(claims({ upgradeUntil: -1 })) },
    { name: 'a lowest version of 1.5', token: await sign(claims({ minMajor: 1.5 })) },
    { name: 'an empty product', token: await sign(claims({ product: '' })) },
    { name: 'no entitlements at all: valid, read as {}', token: await sign(claims({ ent: undefined })) },
  ]
}

/** Matching is exact (only the key is compared without case), and only a `true` test flag is a test licence. */
async function exactMatching(ctx: Context): Promise<LeaseCase[]> {
  return [
    { name: 'the activation id in another case', token: await sign(claims({ aid: AID.toUpperCase() })) },
    { name: 'the product in another case', token: await sign(claims({ product: PRODUCT.toUpperCase() })) },
    { name: "this device's claim in capitals, held to a machine", token: await sign(claims({ fp: ctx.ownClaim.toUpperCase(), fpk: 'machine' })) },
    { name: 'a test flag that is false', token: await sign(claims({ test: false })) },
    { name: 'held to a machine, with no device claim', token: await sign(claims({ fpk: 'machine' })) },
  ]
}

/** Every kind of entitlement value: a text, whole and fractional numbers, a negative one, flags, an empty text. */
export const MIXED_ENT = { edition: 'pro', seats: 5, ratio: 0.5, discount: -2, beta: false, cloud: true, label: '' }

/**
 * Entitlements (`ent`), read leniently: kept as signed; a member that is not a flag, a number or a
 * text dropped, the rest kept; anything but an object read as none; never a refusal of the lease,
 * and none of the server's caps enforced.
 */
async function entitlements(): Promise<LeaseCase[]> {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`feature${i}`, i]))
  const pastCaps = { ...many, ['n'.repeat(40)]: true, notes: 't'.repeat(100) }
  const numbers = { big: 3_000_000_000, huge: 1e21, tiny: 1e-7, negative: -1.5 }
  return [
    { name: 'entitlements of every kind: kept as signed', token: await sign(claims({ ent: MIXED_ENT })) },
    {
      name: 'entitlements with malformed members beside good ones: the good ones kept, the lease valid',
      token: await sign(claims({ ent: { nested: { tier: 'gold' }, edition: 'pro', none: null, list: ['a'], seats: 2 } })),
    },
    { name: 'entitlements whose members are all malformed: none, the lease valid', token: await sign(claims({ ent: { nested: {}, none: null, list: [] } })) },
    { name: 'entitlements that are null: none, the lease valid', token: await sign(claims({ ent: null })) },
    { name: 'entitlements that are a list with members: none, the lease valid', token: await sign(claims({ ent: ['pro', true] })) },
    { name: 'entitlements that are a text: none, the lease valid', token: await sign(claims({ ent: 'pro' })) },
    { name: 'entitlements that are a number: none, the lease valid', token: await sign(claims({ ent: 42 })) },
    { name: 'entitlements that are a flag: none, the lease valid', token: await sign(claims({ ent: true })) },
    { name: 'entitlements past every cap the server keeps: all kept, the signature trusted', token: await sign(claims({ ent: pastCaps })) },
    { name: 'entitlement names and texts beyond ASCII: kept as signed', token: await sign(claims({ ent: { édition: 'Pro Studio ✓', 版本: '专业版' } })) },
    { name: 'an entitlement named __proto__: kept like any other', token: await sign(claims({ ent: JSON.parse('{"__proto__":"pro","seats":1}') })) },
    { name: 'an expired lease with entitlements: its claims keep them', token: await sign(claims({ exp: NOW_S - 1, ent: MIXED_ENT })) },
    {
      name: 'entitlement numbers past 2^31, in exponent form and fractional: kept as doubles',
      token: await sign(claims({ ent: numbers })),
    },
    { name: "an entitlement with an empty name, below the server's caps: kept", token: await sign(claims({ ent: { '': 'unnamed', seats: 1 } })) },
    {
      // Each is the nearest double to what JSON writes, which a reader that is not correctly rounded misses.
      name: 'entitlement numbers that need correct rounding: kept as the nearest double',
      token: await sign(claims({ ent: { ratio: 221.62324973788606, share: 975.1952520418383, total: 123456789012345680000 } })),
    },
    { name: 'entitlement names and texts past U+FFFF: kept as signed', token: await sign(claims({ ent: { '\u{1F3B5}': 'Pro \u{1D11E}' } })) },
  ]
}

/**
 * Leases that name the key that signed them (`kid`), judged with the vectors'
 * key set of one: its own key's id verifies; another's is `unknown-key`, before
 * the lease's end is read.
 */
async function keysNamed(): Promise<LeaseCase[]> {
  const own = { ...HEADER, kid: await keyId(TEST_PUBLIC_JWK) }
  const next = { ...HEADER, kid: await keyId({ kty: 'OKP', crv: 'Ed25519', x: NEXT_PRIVATE_JWK.x }) }
  return [
    { name: "a lease naming the vectors' key: licensed", token: await sign(claims(), own) },
    { name: 'a lease naming a key the build does not carry: unknown-key', token: await sign(claims(), next, NEXT_PRIVATE_JWK) },
    {
      name: 'an expired lease naming a key the build does not carry: unknown-key, its end not read',
      token: await sign(claims({ exp: NOW_S - 1 }), next, NEXT_PRIVATE_JWK),
    },
  ]
}
