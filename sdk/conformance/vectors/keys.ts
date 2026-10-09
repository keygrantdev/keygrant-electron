/**
 * The key-set groups: a public key's id (`keyIds`), a lease verified against a
 * key set (`keySets`), and whether entitlements grant a code (`grants`). A
 * group only ever grows at its end, so no vector an SDK already answers moves.
 */
import { keyId } from '@keygrant/shared'
import type { GroupInputs } from '../inputs.js'
import {
  HEADER,
  NEXT_PRIVATE_JWK,
  NOW,
  NOW_S,
  OTHER_PRIVATE_JWK,
  TEST_PRIVATE_JWK,
  TEST_PUBLIC_JWK,
  b64url,
  claims,
  part,
  publicOf,
  segments,
  sign,
  signInput,
  strayBit,
  utf8,
} from './common.js'

const CURRENT = publicOf(TEST_PUBLIC_JWK)
const NEXT = publicOf(NEXT_PRIVATE_JWK)
const OTHER = publicOf(OTHER_PRIVATE_JWK)

/** 32 bytes that are no point on the curve (y = 2 has no x): a key all the same, which verifies nothing. */
export const OFF_CURVE = { kty: 'OKP', crv: 'Ed25519', x: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }

/** RFC 8037's example Ed25519 public key, whose RFC 7638 thumbprint the RFC gives. */
const RFC_8037 = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }

export async function keyIds(): Promise<GroupInputs['keyIds'][]> {
  return [
    { name: "the vectors' key", jwk: CURRENT },
    { name: 'the next key', jwk: NEXT },
    { name: "RFC 8037's example key, whose thumbprint the RFC gives", jwk: RFC_8037 },
    {
      name: 'a JWK with its members in another order, a kid member and a use: only the key is read',
      jwk: JSON.parse(`{"x":"${NEXT.x}","kid":"chosen-by-hand","use":"sig","crv":"Ed25519","kty":"OKP"}`) as JsonWebKey,
    },
    { name: 'a JWK whose x was pasted with base64 padding: the same key, the same id', jwk: { ...NEXT, x: `${NEXT.x}=` } },
    // What a public key must be: each allowed form read, each rule refusing once (expect null).
    { name: 'a JWK with use sig, key_ops naming verify and alg EdDSA: the key', jwk: { ...NEXT, use: 'sig', key_ops: ['verify'], alg: 'EdDSA' } },
    { name: 'a JWK with alg Ed25519: the key', jwk: { ...NEXT, alg: 'Ed25519' } },
    { name: 'a JWK holding a private key (d): refused', jwk: { ...NEXT, d: b64url(new Uint8Array(32)) } },
    { name: 'a JWK with no kty: refused', jwk: { crv: 'Ed25519', x: NEXT.x } },
    { name: 'a JWK with no crv: refused', jwk: { kty: 'OKP', x: NEXT.x } },
    { name: 'a JWK of another key type: refused', jwk: { ...NEXT, kty: 'EC' } },
    { name: 'a JWK of another curve: refused', jwk: { ...NEXT, crv: 'X25519' } },
    { name: 'a JWK for encryption (use enc): refused', jwk: { ...NEXT, use: 'enc' } },
    { name: 'a JWK whose key_ops do not name verify: refused', jwk: { ...NEXT, key_ops: ['sign'] } },
    { name: 'a JWK whose key_ops are not a list: refused', jwk: { ...NEXT, key_ops: 'verify' } },
    { name: 'a JWK for another algorithm: refused', jwk: { ...NEXT, alg: 'ES256' } },
    { name: 'a JWK with no x: refused', jwk: { kty: 'OKP', crv: 'Ed25519' } },
    { name: 'a JWK whose x is not text: refused', jwk: { ...NEXT, x: 7 } },
    { name: "a JWK whose x is in base64's standard alphabet: refused", jwk: { ...NEXT, x: NEXT.x.replace(/-/g, '+').replace(/_/g, '/') } },
    { name: 'a JWK whose x holds white space: refused', jwk: { ...NEXT, x: `${NEXT.x.slice(0, 20)} ${NEXT.x.slice(20)}` } },
    { name: 'a JWK whose x has a stray bit in its last character: refused', jwk: { ...NEXT, x: strayBit(NEXT.x) } },
    { name: 'a JWK whose x is 31 bytes: refused', jwk: { ...NEXT, x: b64url(new Uint8Array(31).fill(7)) } },
    { name: 'a JSON list, not a JWK: refused', jwk: [NEXT] },
    { name: 'a JWK whose x is 32 bytes but no point on the curve: a key all the same, with its id', jwk: OFF_CURVE },
    { name: 'a JWK whose use is null: refused', jwk: { ...NEXT, use: null } },
    { name: 'a JWK whose key_ops are null: refused', jwk: { ...NEXT, key_ops: null } },
    { name: 'a JWK whose alg is null: refused', jwk: { ...NEXT, alg: null } },
    { name: 'a JWK whose d is null: refused, a private member at all', jwk: { ...NEXT, d: null } },
  ]
}

/** A lease's header naming `kid`. */
const named = (kid: unknown) => ({ ...HEADER, kid })

export async function keySets(): Promise<GroupInputs['keySets'][]> {
  const current = await keyId(CURRENT)
  const next = await keyId(NEXT)
  const other = await keyId(OTHER)
  const both = [CURRENT, NEXT]
  const lease = claims()
  const byOther = await sign(lease, named(other), OTHER_PRIVATE_JWK)
  const raw = (header: string, jwk: JsonWebKey) => signInput(`${header}.${part(lease)}`, jwk)
  return [
    { name: 'a lease naming the current key, signed by it', keys: both, token: await sign(lease, named(current)), now: NOW },
    { name: 'a lease naming the second key of the set, signed by it', keys: both, token: await sign(lease, named(next), NEXT_PRIVATE_JWK), now: NOW },
    { name: 'a lease naming no key, signed by the first key: each key tried in turn', keys: both, token: await sign(lease), now: NOW },
    { name: 'a lease naming no key, signed by the second key: each key tried in turn', keys: both, token: await sign(lease, HEADER, NEXT_PRIVATE_JWK), now: NOW },
    { name: 'a lease naming a key the set does not hold: unknown-key', keys: both, token: byOther, now: NOW },
    {
      name: 'a build carrying only the old key, given a lease naming the next one: unknown-key',
      keys: [CURRENT],
      token: await sign(lease, named(next), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a lease naming the second key but signed by the first: verified by the named key only, bad-signature',
      keys: both,
      token: await sign(lease, named(next)),
      now: NOW,
    },
    { name: 'a lease naming no key that no key of the set signed: bad-signature', keys: both, token: await sign(lease, HEADER, OTHER_PRIVATE_JWK), now: NOW },
    { name: 'a kid that is a number: names no key, each key tried', keys: both, token: await sign(lease, named(7), NEXT_PRIVATE_JWK), now: NOW },
    { name: 'a kid that is null: names no key, each key tried', keys: both, token: await sign(lease, named(null), NEXT_PRIVATE_JWK), now: NOW },
    { name: 'a header that is not JSON: names no key, each key tried', keys: both, token: await raw(b64url(utf8('not json')), NEXT_PRIVATE_JWK), now: NOW },
    { name: 'a header that is a JSON list: names no key, each key tried', keys: both, token: await raw(part([next]), NEXT_PRIVATE_JWK), now: NOW },
    {
      name: 'a header naming a key, not canonical base64url: names no key, each key tried',
      keys: both,
      token: await raw(nonCanonical(part(named(other))), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    { name: 'an empty kid: not the form a header names a key in, each key tried', keys: both, token: await sign(lease, named(''), NEXT_PRIVATE_JWK), now: NOW },
    {
      name: 'a kid naming the second key in another case: matched exactly, unknown-key',
      keys: both,
      token: await sign(lease, named(swapCase(next)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a set naming a key twice: kept once, in the order first given',
      keys: [NEXT, CURRENT, NEXT],
      token: await sign(lease, named(current)),
      now: NOW,
    },
    {
      name: 'an expired lease naming the second key: expired, with its claims',
      keys: both,
      token: await sign(claims({ exp: NOW_S - 1 }), named(next), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a lease naming a key the set does not hold, its signature not base64url: malformed first',
      keys: both,
      token: `${segments(byOther)[0]}.${segments(byOther)[1]}.not+base64url`,
      now: NOW,
    },
    {
      name: 'a key the set does not hold, named with the members in another order: names no key, each key tried',
      keys: both,
      token: await raw(b64url(utf8(`{"kid":"${other}","alg":"EdDSA","typ":"JWT"}`)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a key the set does not hold, named with a space: names no key, each key tried, bad-signature',
      keys: both,
      token: await raw(b64url(utf8(`{"alg":"EdDSA", "typ":"JWT","kid":"${other}"}`)), OTHER_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a key the set does not hold, named with a member more: names no key, each key tried',
      keys: both,
      token: await raw(b64url(utf8(`{"alg":"EdDSA","typ":"JWT","kid":"${other}","jku":"x"}`)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a key the set does not hold, named after a byte-order mark: names no key, each key tried',
      keys: both,
      token: await raw(b64url(utf8(`﻿{"alg":"EdDSA","typ":"JWT","kid":"${other}"}`)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a kid with a character outside base64url: names no key, each key tried',
      keys: both,
      token: await sign(lease, named(`${other}.`), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a kid of 65 characters: names no key, each key tried',
      keys: both,
      token: await sign(lease, named('k'.repeat(65)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a kid of 64 characters the set does not hold: unknown-key',
      keys: both,
      token: await sign(lease, named('k'.repeat(64)), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a kid past ASCII (a lone surrogate, written as the replacement character U+FFFD): names no key, each key tried',
      keys: both,
      token: await raw(b64url(utf8('{"alg":"EdDSA","typ":"JWT","kid":"\ud800"}')), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    {
      name: 'a header cut off inside its kid: names no key, each key tried',
      keys: both,
      token: await raw(b64url(utf8('{"alg":"EdDSA","typ":"JWT","kid":"}')), NEXT_PRIVATE_JWK),
      now: NOW,
    },
    { name: 'a set of one, the single key as before: a lease naming no key', keys: [CURRENT], token: await sign(lease), now: NOW },
    { name: 'a set of one: a lease naming its key', keys: [CURRENT], token: await sign(lease, named(current), TEST_PRIVATE_JWK), now: NOW },
    {
      name: 'a set whose first key is no point on the curve, a lease naming no key: that key verifies nothing, the next does',
      keys: [OFF_CURVE, CURRENT],
      token: await sign(lease),
      now: NOW,
    },
    {
      name: 'a lease naming the key of the set that is no point on the curve: bad-signature',
      keys: [OFF_CURVE, CURRENT],
      token: await sign(lease, named(await keyId(OFF_CURVE))),
      now: NOW,
    },
  ]
}

/** A segment with a stray bit in its last character, or, when it has none, a padding character: the same bytes, not canonical. */
function nonCanonical(segment: string): string {
  return segment.length % 4 === 0 ? `${segment}=` : strayBit(segment)
}

/** A text with each letter's case swapped. */
function swapCase(text: string): string {
  return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')
}

export async function grants(): Promise<GroupInputs['grants'][]> {
  const ent = { cloud: true, beta: false, seats: 5, none: 0, unlimited: -1, share: 0.5, edition: 'pro', blank: '', édition: 'studio' }
  return [
    { name: 'a flag that is on', ent, code: 'cloud' },
    { name: 'a flag that is off', ent, code: 'beta' },
    { name: 'a number that is not zero', ent, code: 'seats' },
    { name: 'a number that is zero', ent, code: 'none' },
    { name: 'a negative number', ent, code: 'unlimited' },
    { name: 'a fraction', ent, code: 'share' },
    { name: 'a text that is not empty', ent, code: 'edition' },
    { name: 'an empty text', ent, code: 'blank' },
    { name: 'a code the entitlements do not hold', ent, code: 'export' },
    { name: 'a code in another case than the one signed', ent, code: 'Cloud' },
    { name: 'a code beyond ASCII, matched exactly', ent, code: 'édition' },
    { name: 'an object member name that is not signed (constructor)', ent, code: 'constructor' },
    { name: 'a malformed member, dropped when read: not granted', ent: { nested: { on: true }, list: [true] }, code: 'nested' },
    { name: 'entitlements that are not an object: none granted', ent: ['cloud'], code: 'cloud' },
    { name: 'no entitlements at all', ent: {}, code: 'cloud' },
  ]
}
