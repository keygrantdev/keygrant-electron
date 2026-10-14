/**
 * What each licence-file group (`FileGroup`) must cover, as `coverage.ts`
 * says of the others: every outcome its decision gives keeps a vector. Each
 * group's `rule` facet also tells every vector apart (`src/conformance.test.ts`
 * checks no two share one), by its inputs and, for `licenseFiles`, what
 * verifying them said (the one way to tell a payload that is not JSON under a
 * signature over it from the same payload under another's), so deleting any
 * vector, not only the last of an outcome, fails.
 */
import { createHash } from 'node:crypto'
import { MAX_LICENSE_FILE_BYTES, OPEN_MAJOR } from '@keygrant/shared'
import type { FileGroup } from './inputs.js'
import { obj, payloadOrNone, type Facet, type Vector } from './facets.js'
import { NEXT_PRIVATE_JWK, OTHER_PRIVATE_JWK, TEST_PUBLIC_JWK } from './vectors/common.js'
import { MADE_UP_KID, SWAPPED_MAJOR, swapCase } from './vectors/files.js'

/** A licence file's header as the server writes it, around the key id. */
const FILE_HEADER = /^\{"alg":"EdDSA","typ":"kglicense\+jwt","kid":"([A-Za-z0-9_-]{1,64})"\}$/

/** A byte-order mark, as text. */
const BOM = String.fromCharCode(0xfeff)

/** A public key's RFC 7638 thumbprint, as `keyId` computes it, synchronously. */
const thumbprint = (jwk: unknown) =>
  createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${String(obj(jwk).x)}"}`).digest('base64url')

/** The vectors' keys, by id. */
const KNOWN: Record<string, string> = {
  [thumbprint(TEST_PUBLIC_JWK)]: 'the current key',
  [thumbprint(NEXT_PRIVATE_JWK)]: 'the next key',
  [thumbprint(OTHER_PRIVATE_JWK)]: "someone else's key",
  [MADE_UP_KID]: 'a made-up kid',
  [swapCase(thumbprint(TEST_PUBLIC_JWK))]: 'the current key in another case',
}

/** A token's segment decoded as text, or null when it is not canonical base64url. */
function segmentText(token: unknown, index: number): string | null {
  const segment = String(token).split('.')[index] ?? ''
  const bytes = Buffer.from(segment, 'base64url')
  return bytes.toString('base64url') === segment ? bytes.toString('latin1') : null
}

/** How a vector's token is put together: its parts, and whether its signature is canonical. */
function form(v: Vector): string {
  const parts = String(v.token).split('.').length
  if (parts !== 3) return `${parts} parts`
  const signature = segmentText(v.token, 2)
  if (signature === null) return 'a signature not canonical'
  return signature.length === 64 ? '3 parts' : `3 parts, a signature of ${signature.length} bytes`
}

/** What a vector's header is: a licence file's naming a key (which, and where in the set), or what else. */
function header(v: Vector): string {
  const text = segmentText(v.token, 0)
  if (text === null) return 'a header not canonical'
  const kid = FILE_HEADER.exec(text)?.[1]
  if (kid === undefined) {
    if (text.includes('"typ":"JWT"')) return `a lease's header${text.includes('"kid"') ? ' naming a key' : ''}`
    if (!text.includes('"kid"')) return 'a file header naming no key'
    return /"kid":"[^"]{65,}"/.test(text) ? 'a kid too long' : text.includes(', ') ? 'a header with a space' : 'members in another order'
  }
  const kids = (v.keys as unknown[]).map(thumbprint)
  const which = KNOWN[kid] ?? 'a kid the vectors do not know'
  const place = !kids.includes(kid) ? 'not in the set' : kids.indexOf(kid) === 0 ? 'first' : 'later'
  return `${which}, ${place} of ${kids.length}`
}

/** Each thing `LicenseFileClaims` may find wrong with a payload's claims, by name; `text` is the payload as written. */
const CLAIM_ISSUES: [string, (c: Record<string, unknown>, text: string) => boolean][] = [
  ['another issuer', (c) => c.iss !== 'keygrant'],
  ['another kind', (c) => c.kind !== 'key' && c.kind !== 'offline'],
  ['no fid', (c) => c.fid === undefined],
  ['no licensee', (c) => c.name === undefined && c.email === undefined],
  ['an empty name', (c) => c.name === ''],
  ['a null name', (c) => c.name === null],
  ['no major', (c) => c.kind === 'offline' && c.major === undefined],
  ['major 0', (c) => c.major === 0],
  ['a major written with a fraction part', (_, text) => /"major":\d+\./.test(text)],
  ['no iat', (c) => c.iat === undefined],
  ['a test claim not a flag', (c) => c.test !== undefined && typeof c.test !== 'boolean'],
  ['a negative iat', (c) => typeof c.iat === 'number' && c.iat < 0],
  ['an iat with a fraction', (c) => typeof c.iat === 'number' && !Number.isInteger(c.iat)],
  ['an empty email', (c) => c.email === ''],
  ['an empty sub', (c) => c.sub === ''],
  ['an empty product', (c) => c.product === ''],
  ['an empty fid', (c) => c.fid === ''],
  ['minMajor 0', (c) => c.minMajor === 0],
  ['an exp', (c) => 'exp' in c],
  ['a key file with versions', (c) => c.kind === 'key' && 'major' in c],
]

/** What is wrong with a vector's claims, as `LicenseFileClaims` reads them, or that nothing is. */
function claimsIssue(v: Vector): string {
  const text = segmentText(v.token, 1)
  if (text === null) return 'a payload not canonical'
  let c: Record<string, unknown>
  try {
    c = obj(JSON.parse(Buffer.from(text, 'latin1').toString('utf8')))
  } catch {
    return 'a payload not JSON'
  }
  if ('aid' in c) return "a lease's claims"
  const issues = CLAIM_ISSUES.filter(([, found]) => found(c, text)).map(([issue]) => issue)
  return issues.length > 0 ? issues.join(', ') : 'well formed'
}

/** Who a file names, by its claims as signed. */
function licensee(v: Vector): string {
  const c = payloadOrNone(v.token)
  return c.name !== undefined && c.email !== undefined ? 'name and email' : c.name !== undefined ? 'name' : c.email !== undefined ? 'email' : 'no one'
}

/** Where a build's major stands against a range from `low` to `high`. */
function placeIn(major: number, low: number, high: number): string {
  if (major < low) return 'below'
  if (major > high) return 'above'
  if (major === low) return 'at its lowest'
  return major === high ? 'at its highest' : 'inside'
}

/** Where the build stands against an offline file's range, when its signature held. */
function range(v: Vector): string {
  const c = obj(obj(v.verify).claims)
  if (c.kind === 'key') return `a key file, build ${String(v.major)}`
  if (c.kind !== 'offline') return 'not read'
  const marks = [
    Number(c.major) >= OPEN_MAJOR ? 'open-ended, ' : '',
    c.minMajor === undefined ? 'no minMajor, ' : '',
    Number(c.minMajor) > Number(c.major) ? 'inverted, ' : '',
  ]
  return `${marks.join('')}${placeIn(Number(v.major), Number(c.minMajor ?? 1), Number(c.major))}`
}

/** What the denylist holds of a vector's file id. */
function listed(v: Vector): string {
  const revoked = v.revoked as string[]
  const fid = String(payloadOrNone(v.token).fid)
  if (revoked.length === 0) return 'none listed'
  if (revoked.includes(fid)) return 'its id listed'
  return revoked.some((id) => id.toLowerCase() === fid.toLowerCase()) ? 'its id in another case' : 'other ids'
}

/** What a vector's file grants, as signed. */
function entKind(v: Vector): string {
  const ent = payloadOrNone(v.token).ent
  if (ent === undefined) return 'no ent'
  if (ent === null) return 'ent null'
  if (typeof ent !== 'object' || Array.isArray(ent)) return 'ent not an object'
  const values = Object.values(ent)
  if (values.length === 0) return 'ent empty'
  return values.some((x) => typeof x === 'object') ? 'ent with a malformed member' : 'ent with members'
}

/** A licence-file vector's inputs, told apart: everything the decision reads of them. */
function fileRule(v: Vector): string {
  const p = payloadOrNone(v.token)
  return [
    form(v),
    header(v),
    claimsIssue(v),
    licensee(v),
    range(v),
    listed(v),
    p.product === v.product ? 'this product' : 'another product',
    entKind(v),
    p.test === true ? 'test' : 'real',
    p.major === SWAPPED_MAJOR ? "another file's payload" : '',
    String(obj(v.verify).valid === true ? 'valid' : obj(v.verify).reason),
  ]
    .filter((part) => part !== '')
    .join('; ')
}

/** What the judgement said: the file's kind and its verdict. */
function verdict(v: Vector): string {
  const e = obj(v.expect)
  if (e.ok === true) return `${String(e.kind)}: ok${e.test === true ? ', test' : ''}`
  return String(e.reason)
}

/** A status's state, reason and which members it carries. */
function statusShape(v: Vector): string {
  const s = obj(v.status)
  const members = ['key', 'source', 'licensedTo', 'test', 'entitlements'].filter((m) => m in s)
  return `${String(s.state)}${s.reason !== undefined ? `: ${String(s.reason)}` : ''} [${members.join(', ')}]`
}

/** What a container's text shows, each by name: what `licenseFileToken` reads past. */
const CONTAINER_MARKS: [string, (text: string) => boolean][] = [
  ['a byte-order mark', (text) => text.startsWith(BOM)],
  ['CRLF', (text) => text.includes('\r\n')],
  ['a lone CR', (text) => /\r(?!\n)/.test(text)],
  ['an indented comment', (text) => /^[ \t]+#/m.test(text)],
  ['a padded line', (text) => /^[ \t]+[^ \t#\r\n]/m.test(text)],
  ['a form feed, kept', (text) => /\f/.test(text)],
  ['a vertical tab, kept', (text) => /\v/.test(text)],
  ['a no-break space, kept', (text) => /\u00a0/.test(text)],
  ['two byte-order marks', (text) => text.startsWith(BOM + BOM)],
]

/** The lines a container's text leaves once trimmed, empty lines and comments left out. */
function tokenLines(text: string): string[] {
  return (text.startsWith(BOM) ? text.slice(1) : text)
    .split('\n')
    .map((l) => l.replace(/^[ \t\r]+|[ \t\r]+$/g, ''))
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/** What a container's bytes are, as `licenseFileToken` reads them, and what came of it. */
function containerRule(v: Vector): string {
  const bytes = Buffer.from(String(v.bytes), 'base64url')
  const outcome = v.expect === null ? 'null' : 'a token'
  if (bytes.length > MAX_LICENSE_FILE_BYTES) return `past the bound: ${outcome}`
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return `not UTF-8${bytes[0] === 0xff && bytes[1] === 0xfe ? ', UTF-16' : ''}: ${outcome}`
  }
  const lines = tokenLines(text)
  const marks = [
    ...(bytes.length === MAX_LICENSE_FILE_BYTES ? ['at the bound'] : []),
    ...CONTAINER_MARKS.filter(([, shown]) => shown(text)).map(([mark]) => mark),
    text.includes('#') ? 'comments' : 'no comments',
  ]
  const other = lines.some((line) => line.split('.').length !== 3) ? ' (one not a token)' : ''
  return `${lines.length} lines${other}, ${marks.join(', ')}: ${outcome}`
}

export const FILE_COVERAGE: Record<FileGroup, Record<string, Facet>> = {
  licenseFileContainers: {
    rule: {
      of: containerRule,
      expect: [
        "0 lines, comments: null",
        "0 lines, no comments: null",
        "1 lines, CRLF, comments: a token",
        "1 lines, a byte-order mark, comments: a token",
        "1 lines, a byte-order mark, two byte-order marks, no comments: a token",
        "1 lines, a form feed, kept, no comments: a token",
        "1 lines, a lone CR, comments: a token",
        "1 lines, a no-break space, kept, no comments: a token",
        "1 lines, a padded line, no comments: a token",
        "1 lines, a vertical tab, kept, no comments: a token",
        "1 lines, an indented comment, comments: a token",
        "1 lines, at the bound, comments: a token",
        "1 lines, comments: a token",
        "1 lines, no comments: a token",
        "2 lines (one not a token), no comments: null",
        "2 lines, no comments: null",
        "not UTF-8, UTF-16: null",
        "not UTF-8: null",
        "past the bound: null",
      ],
    },
  },
  licenseFiles: {
    verdict: {
      of: verdict,
      expect: [
        'bad-signature',
        'key: ok',
        'malformed',
        'not-a-license-file',
        'offline: ok',
        'offline: ok, test',
        'outdated',
        'revoked-file',
        'unknown-key',
        'upgrade',
        'wrong-product',
      ],
    },
    status: {
      of: statusShape,
      expect: [
        'invalid: outdated [key, source, licensedTo]',
        'invalid: revoked-file [key, source, licensedTo]',
        'invalid: tampered [source]',
        'invalid: unknown-key [source]',
        'invalid: upgrade [key, source, licensedTo]',
        'licensed [key, source, licensedTo, entitlements]',
        'licensed [key, source, licensedTo, test]',
        'licensed [key, source, licensedTo]',
      ],
    },
    rule: {
      of: fileRule,
      expect: [
        "2 parts; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; malformed",
        "3 parts, a signature of 0 bytes; a made-up kid, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; unknown-key",
        "3 parts, a signature of 0 bytes; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; bad-signature",
        "3 parts, a signature of 63 bytes; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; bad-signature",
        "3 parts; a file header naming no key; well formed; name and email; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a header not canonical; well formed; name and email; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a header with a space; well formed; name and email; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a kid too long; well formed; name and email; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a lease's header naming a key; a lease's claims; no one; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a lease's header; a lease's claims; no one; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; a made-up kid, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; unknown-key",
        "3 parts; members in another order; well formed; name and email; not read; none listed; this product; ent empty; real; not-a-license-file",
        "3 parts; someone else's key, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; unknown-key",
        "3 parts; the current key in another case, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; unknown-key",
        "3 parts; the current key, first of 1; a key file with versions; name and email; a key file, build 7; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; a lease's claims; no one; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; a major written with a fraction part; name and email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; a negative iat; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; a null name; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; a payload not JSON; no one; not read; none listed; another product; no ent; real; bad-claims",
        "3 parts; the current key, first of 1; a payload not JSON; no one; not read; none listed; another product; no ent; real; bad-signature",
        "3 parts; the current key, first of 1; a payload not canonical; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; a test claim not a flag; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an empty email; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an empty fid; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an empty name; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an empty product; name and email; not read; none listed; another product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an empty sub; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; an exp; name and email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; an iat with a fraction; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; another issuer, another kind, no fid, no licensee, no iat; no one; not read; none listed; another product; no ent; real; bad-claims",
        "3 parts; the current key, first of 1; another issuer; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; another kind; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; major 0; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; minMajor 0; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; no fid; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; no iat; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; no licensee; no one; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; no major; name and email; not read; none listed; this product; ent empty; real; bad-claims",
        "3 parts; the current key, first of 1; well formed; email; a key file, build 3; its id listed; this product; no ent; real; valid",
        "3 parts; the current key, first of 1; well formed; email; a key file, build 3; none listed; another product; no ent; real; valid",
        "3 parts; the current key, first of 1; well formed; email; a key file, build 50; none listed; this product; no ent; real; valid",
        "3 parts; the current key, first of 1; well formed; email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; above; its id listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; above; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; above; none listed; this product; ent with members; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; at its highest; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; at its lowest; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; below; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; its id in another case; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; its id listed; another product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; its id listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; another product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent empty; test; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent not an object; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent null; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent with a malformed member; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inside; none listed; this product; ent with members; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; inverted, below; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; no minMajor, at its lowest; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; another file's payload; bad-signature",
        "3 parts; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; bad-signature",
        "3 parts; the current key, first of 1; well formed; name and email; open-ended, inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, first of 1; well formed; name; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, later of 2; well formed; name and email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the current key, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; unknown-key",
        "3 parts; the next key, later of 2; well formed; name and email; inside; none listed; this product; ent empty; real; valid",
        "3 parts; the next key, later of 2; well formed; name and email; not read; none listed; this product; ent empty; real; bad-signature",
        "4 parts; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; malformed",
        "a signature not canonical; a lease's header naming a key; a lease's claims; no one; not read; none listed; this product; ent empty; real; not-a-license-file",
        "a signature not canonical; someone else's key, not in the set of 1; well formed; name and email; not read; none listed; this product; ent empty; real; malformed",
        "a signature not canonical; the current key, first of 1; well formed; name and email; not read; none listed; this product; ent empty; real; malformed",
      ],
    },
  },
  filesAsLeases: {
    outcome: {
      of: (v) => `${String(payloadOrNone(v.token).kind)} file, ${String(obj(v.verify).reason)}, ${String(obj(v.expect).reason)}, trial ${String(v.trial)}`,
      expect: ['key file, bad-claims, tampered, trial false', 'offline file, bad-claims, tampered, trial false', 'offline file, bad-signature, tampered, trial false'],
    },
  },
}
