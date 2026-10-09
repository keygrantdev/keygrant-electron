/**
 * What each key-set group (`KeyGroup`) must cover, as `coverage.ts` says of the
 * others: every outcome its decision gives keeps a vector, so deleting the only
 * vector of one fails.
 */
import type { KeyGroup } from './inputs.js'
import { OFF_CURVE } from './vectors/keys.js'
import { answer, obj, type Facet, type Vector } from './facets.js'

/** What the server writes a header naming a key as, around the id. */
const NAMED = /^\{"alg":"EdDSA","typ":"JWT","kid":"([A-Za-z0-9_-]{1,64})"\}$/

/** What a vector's lease names its key by, against the set it is verified with: only a header of the server's form names one. */
function kidNamed(v: Vector): string {
  const segment = String(v.token).split('.')[0] ?? ''
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) return 'a header not canonical base64url'
  const kid = NAMED.exec(bytes.toString('latin1'))?.[1]
  if (kid === undefined) return bytes.toString('latin1').includes('"kid"') ? "a kid not in the server's form" : 'no kid'
  const kids = (v.kids as string[] | undefined) ?? []
  if (kids.includes(kid)) return kids.indexOf(kid) === 0 ? 'the first key of the set' : 'a later key of the set'
  return 'a key the set does not hold'
}

/** What verifying said. */
function verdict(v: Vector): string {
  const r = obj(v.verify)
  return `${r.valid === true ? 'valid' : String(r.reason)}${r.claims !== undefined ? ', with claims' : ''}`
}

/** Which rule of a public key (`publicKeyBytes`) a vector's JWK meets first, and whether it was refused. */
function keyRule(v: Vector): string {
  const outcome = v.expect === null ? 'refused' : 'an id'
  if (typeof v.jwk !== 'object' || v.jwk === null || Array.isArray(v.jwk)) return `not an object: ${outcome}`
  const j = obj(v.jwk)
  const rule =
    'd' in j
      ? 'd'
      : !('kty' in j) || !('crv' in j)
        ? 'kty or crv missing'
        : j.kty !== 'OKP' || j.crv !== 'Ed25519'
          ? 'kty or crv another'
          : 'use' in j && j.use !== 'sig'
            ? 'use another'
            : 'key_ops' in j && !(Array.isArray(j.key_ops) && j.key_ops.includes('verify'))
              ? 'key_ops without verify'
              : 'alg' in j && j.alg !== 'EdDSA' && j.alg !== 'Ed25519'
                ? 'alg another'
                : typeof j.x !== 'string'
                  ? 'x not text'
                  : !/^[A-Za-z0-9_-]*$/.test(j.x.replace(/=+$/, ''))
                    ? 'x outside the alphabet'
                    : Buffer.from(j.x.replace(/=+$/, ''), 'base64url').toString('base64url') !== j.x.replace(/=+$/, '')
                      ? 'x not canonical'
                      : Buffer.from(j.x, 'base64url').length !== 32
                        ? 'x not 32 bytes'
                        : 'every rule met'
  return `${rule}: ${outcome}`
}

export const KEY_COVERAGE: Record<KeyGroup, Record<string, Facet>> = {
  keyIds: {
    members: {
      of: (v) => {
        if (String(obj(v.jwk).x).endsWith('=')) return 'x padded'
        return Object.keys(obj(v.jwk)).join(',') === 'kty,crv,x' ? 'kty, crv, x' : 'other members, other order'
      },
      expect: ['kty, crv, x', 'other members, other order', 'x padded'],
    },
    accepted: {
      of: (v) => {
        if (v.expect === null) return 'refused'
        const j = obj(v.jwk)
        if (j.x === OFF_CURVE.x) return 'no point on the curve'
        return ['use', 'key_ops', 'alg'].some((m) => m in j) ? 'with use, key_ops or alg' : 'kty, crv, x and others'
      },
      expect: ['kty, crv, x and others', 'no point on the curve', 'refused', 'with use, key_ops or alg'],
    },
    nulls: {
      of: (v) => {
        const j = obj(v.jwk)
        const nulled = ['use', 'key_ops', 'alg', 'd'].filter((m) => m in j && j[m] === null)
        return nulled.length > 0 ? `${nulled.join(', ')} null: ${v.expect === null ? 'refused' : 'an id'}` : 'none null'
      },
      expect: ['alg null: refused', 'd null: refused', 'key_ops null: refused', 'none null', 'use null: refused'],
    },
    rule: {
      of: keyRule,
      expect: [
        'alg another: refused',
        'd: refused',
        'every rule met: an id',
        'key_ops without verify: refused',
        'kty or crv another: refused',
        'kty or crv missing: refused',
        'not an object: refused',
        'use another: refused',
        'x not 32 bytes: refused',
        'x not canonical: refused',
        'x not text: refused',
        'x outside the alphabet: refused',
      ],
    },
  },
  keySets: {
    verify: {
      of: verdict,
      expect: ['bad-signature', 'expired, with claims', 'malformed', 'unknown-key', 'valid, with claims'],
    },
    length: {
      of: (v) => {
        const segment = String(v.token).split('.')[0] ?? ''
        const kid = /"kid":"([^"]*)"/.exec(Buffer.from(segment, 'base64url').toString('latin1'))?.[1]
        return kid !== undefined && (kid.length === 64 || kid.length === 65) ? `a kid of ${kid.length} characters: ${verdict(v)}` : 'another'
      },
      expect: ['a kid of 64 characters: unknown-key', 'a kid of 65 characters: valid, with claims', 'another'],
    },
    named: {
      of: (v) => `${kidNamed(v)}: ${verdict(v)}`,
      expect: [
        'a header not canonical base64url: valid, with claims',
        "a kid not in the server's form: bad-signature",
        "a kid not in the server's form: valid, with claims",
        'a key the set does not hold: malformed',
        'a key the set does not hold: unknown-key',
        'a later key of the set: bad-signature',
        'a later key of the set: expired, with claims',
        'a later key of the set: valid, with claims',
        'no kid: bad-signature',
        'no kid: valid, with claims',
        'the first key of the set: bad-signature',
        'the first key of the set: valid, with claims',
      ],
    },
    size: {
      of: (v) => {
        const keys = (v.keys as unknown[]).length
        const kids = (v.kids as unknown[]).length
        return keys === kids ? `${keys} keys` : `${keys} keys, ${kids} kept`
      },
      expect: ['1 keys', '2 keys', '3 keys, 2 kept'],
    },
  },
  grants: {
    granted: { of: answer, expect: ['false', 'true'] },
    kind: {
      of: (v) => {
        const value = obj(v.ent)[String(v.code)]
        if (!Array.isArray(v.ent) && Object.hasOwn(obj(v.ent), String(v.code))) {
          const kind = typeof value === 'boolean' ? 'a flag' : typeof value === 'number' ? 'a number' : typeof value === 'string' ? 'a text' : 'malformed'
          return `${kind}: ${answer(v)}`
        }
        return `not held: ${answer(v)}`
      },
      expect: ['a flag: false', 'a flag: true', 'a number: false', 'a number: true', 'a text: false', 'a text: true', 'malformed: false', 'not held: false'],
    },
  },
}
