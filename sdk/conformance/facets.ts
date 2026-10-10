/**
 * The pieces `coverage.ts` builds each group's facets from: how a vector is
 * read (its fields, a token's payload, a status's shape, the entitlements a
 * lease signs), and the facets of the groups whose outcomes take more than a
 * line to tell apart (merges, device names, renewals, entitlements).
 */

export type Vector = Record<string, unknown>

/** One way of telling a group's vectors apart, and every outcome the group must show. */
export interface Facet {
  of: (vector: Vector) => string
  expect: string[]
}

/** A vector's field as an object (an empty one when it is not). */
export const obj = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The answer as JSON, for decisions whose answers are few. */
export const answer = (v: Vector) => JSON.stringify(v.expect)

/** The classes of a text: empty, ASCII, or not. */
export const script = (text: string) => (text === '' ? 'empty' : /^[\x20-\x7e]*$/.test(text) ? 'ascii' : 'non-ascii')

/** A token's payload, decoded (only ever asked of a token whose payload is JSON). */
export const payloadOf = (token: unknown): Record<string, unknown> =>
  obj(JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')))

/** A token's payload, decoded, or an empty object when it is not JSON. */
export function payloadOrNone(token: unknown): Record<string, unknown> {
  try {
    return payloadOf(token)
  } catch {
    return {}
  }
}

/** What the offline check of a lease said (`checkLease`): licensed (a test licence or not), or why not. */
export function leaseVerdict(v: Vector): string {
  const e = obj(v.expect)
  if (e.ok !== true) return String(e.reason)
  return e.test === true ? 'licensed, test' : 'licensed'
}

/** Where a lease's end falls against the time it is judged at: in its end second exactly, under a second past it, or anywhere else. */
export function endSecond(v: Vector): string {
  const exp = payloadOrNone(v.token).exp
  if (typeof exp !== 'number') return 'otherwise'
  const past = Number(v.now) - exp * 1000
  if (past === 0) return 'judged at its end second'
  return past > 0 && past < 1000 ? 'judged under a second past it' : 'otherwise'
}

/**
 * How a lease that verified (or merely expired) is held to a device: what its
 * `fp` hashes (`fpk`), whose claim that is, and whether this run could tell,
 * with the verdict; one that names neither is held to none.
 */
export function heldTo(v: Vector): string {
  const claims = obj(obj(v.verify).claims)
  if (!('sub' in claims)) return 'no claims'
  if (claims.fp === undefined && claims.fpk === undefined) return 'held to no device'
  const holder = obj(v.holder)
  const mine = Array.isArray(holder.claims) && holder.claims.includes(claims.fp)
  const whose = typeof claims.fp !== 'string' ? 'no device claim' : mine ? 'this device' : 'another device'
  const kind = typeof claims.fpk === 'string' ? claims.fpk : 'no kind'
  const tells = holder.canTell === false ? ', on a run that cannot tell' : ''
  return `${kind}, ${whose}${tells}: ${leaseVerdict(v)}`
}

/** Whose key a lease that verified (or merely expired) names: the one stored, the same in another case, or another, with the verdict. */
export function keyNamed(v: Vector): string {
  const sub = obj(obj(v.verify).claims).sub
  if (typeof sub !== 'string') return 'no claims'
  const key = String(obj(v.holder).key)
  if (sub === key) return 'the key stored'
  return `${sub.toUpperCase() === key.toUpperCase() ? 'the key in another case' : 'another key'}: ${leaseVerdict(v)}`
}

/** Whether a run could tell who the device is (`canTell`, on the vector's `device`), and what it answered. */
export function judgedBy(answerOf: (v: Vector) => string): (v: Vector) => string {
  return (v) => `${obj(v.device).canTell === false ? 'cannot tell' : 'tells'} -> ${answerOf(v)}`
}

/** A JSON number's written form: whole, fraction or exponent, and its sign. */
export function numberForm(v: Vector): string {
  const json = String(v.json)
  const form = /e/i.test(json) ? 'an exponent' : json.includes('.') ? 'a fraction' : 'a whole number'
  return json.startsWith('-') ? `${form}, negative` : form
}

/** Where a number sits among the doubles: the largest, the smallest normal, a subnormal (the smallest of them apart), or in between. */
export function numberRange(v: Vector): string {
  const value = Math.abs(Number(v.json))
  if (value === Number.MAX_VALUE) return 'the largest double'
  if (value === Number.MIN_VALUE) return 'the smallest subnormal'
  if (value === 2.2250738585072014e-308) return 'the smallest normal'
  return value > 0 && value < 2.2250738585072014e-308 ? 'a subnormal' : 'in between'
}

/** What a status says: its state, its reason, its test flag, and whether it carries entitlements. */
export function statusShape(value: unknown): string {
  const s = obj(value)
  const reason = s.reason !== undefined ? `: ${String(s.reason)}` : ''
  return `${String(s.state)}${reason}${s.test === true ? ', test' : ''}${s.entitlements !== undefined ? ', entitled' : ''}`
}

const NOT_AN_OBJECT: Record<string, string> = { string: 'a text', number: 'a number', boolean: 'a flag' }

/**
 * How a token's payload signs `ent`: absent; null, a list, a text, a number or
 * a flag (each read as none); or an object, empty, flat (every member a flag,
 * a number or a text), partly malformed or all malformed.
 */
export function entSigned(token: unknown): string {
  const payload = payloadOf(token)
  if (!('ent' in payload)) return 'absent'
  const ent = payload.ent
  if (ent === null) return 'null'
  if (Array.isArray(ent)) return 'a list'
  if (typeof ent !== 'object') return NOT_AN_OBJECT[typeof ent] ?? typeof ent
  const values = Object.values(ent)
  if (values.length === 0) return 'empty'
  const flat = values.filter((value) => ['boolean', 'number', 'string'].includes(typeof value)).length
  return flat === values.length ? 'flat' : flat === 0 ? 'all malformed' : 'partly malformed'
}

/**
 * What a status group must show: every kind of `ent` signed, each with the
 * status it gives (`statusShape`), so the only vector where a kind licenses, or
 * runs a trial, or is withheld from a status that does not, cannot go unnoticed.
 */
export function signedToStatus(expect: string[]): Facet {
  return { of: (v) => `${entSigned(v.token)} -> ${statusShape(v.expect)}`, expect }
}

/** Whether a value is a whole number whose size is from `low` to `high`. */
const isWholeBetween = (value: unknown, low: number, high: number) =>
  typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= low && Math.abs(value) <= high

/** How many significant digits the shortest text that reads back as a number has. */
const significant = (value: number) => value.toExponential().replace(/e.*$/, '').replace(/[-.]/g, '').length

/** Whether a text holds a character past U+FFFF (two UTF-16 units, four UTF-8 bytes). */
const isAstral = (text: string) => [...text].some((char) => char.length > 1)

/** The properties of a set of entitlements a port could get wrong, each of which some vector must show. */
const SPECIALS: Record<string, (ent: Record<string, unknown>) => boolean> = {
  'a name __proto__': (ent) => Object.hasOwn(ent, '__proto__'),
  'an empty name': (ent) => Object.hasOwn(ent, ''),
  'a name beyond ASCII': (ent) => Object.keys(ent).some((name) => script(name) === 'non-ascii'),
  'more than 16 of them': (ent) => Object.keys(ent).length > 16,
  'a name over 32 characters': (ent) => Object.keys(ent).some((name) => name.length > 32),
  'a text over 64 characters': (ent) => Object.values(ent).some((value) => typeof value === 'string' && value.length > 64),
  'an empty text': (ent) => Object.values(ent).includes(''),
  'a whole number from 2^31 to 2^53': (ent) => Object.values(ent).some((value) => isWholeBetween(value, 2 ** 31, 2 ** 53)),
  'a number of 1e21 or more, which JSON writes with an exponent': (ent) =>
    Object.values(ent).some((value) => typeof value === 'number' && Math.abs(value) >= 1e21),
  'a number below 1e-6': (ent) => Object.values(ent).some((value) => typeof value === 'number' && value !== 0 && Math.abs(value) < 1e-6),
  'a fraction': (ent) => Object.values(ent).some((value) => typeof value === 'number' && !Number.isInteger(value)),
  'a number of 17 significant digits': (ent) => Object.values(ent).some((value) => typeof value === 'number' && significant(value) >= 17),
  'a whole number from 2^64 to 1e21': (ent) => Object.values(ent).some((value) => isWholeBetween(value, 2 ** 64, 1e21)),
  'a character past U+FFFF': (ent) => Object.entries(ent).some(([name, value]) => isAstral(name) || (typeof value === 'string' && isAstral(value))),
  'a negative number': (ent) => Object.values(ent).some((value) => typeof value === 'number' && value < 0),
  'a flag that is false': (ent) => Object.values(ent).includes(false),
}

/**
 * One facet per property (`SPECIALS`, or the ones named): that some vector's
 * entitlements, as `entOf` reads them from its answer, show it.
 */
export function entitlementSpecials(entOf: (v: Vector) => Record<string, unknown>, names = Object.keys(SPECIALS)): Record<string, Facet> {
  return Object.fromEntries(
    names.map((name) => {
      const has = SPECIALS[name]
      if (!has) throw new Error(`no such property of entitlements: ${name}`)
      return [`entitlements with ${name}`, { of: (v: Vector) => (has(entOf(v)) ? 'shown' : 'not shown'), expect: ['not shown', 'shown'] }]
    }),
  )
}

/** The verdict fields, which an answer older than the stored one loses (merge.ts VERDICT_FIELDS). */
const VERDICT = ['lease', 'refused', 'refusedMajor', 'refusedFor', 'backoffSince', 'backoffMs', 'checkedMajor', 'verdictAt']
/** A trial answer's fields, which a trial answer older than the stored one loses. */
const TRIAL_ANSWER = ['trialEndsAt', 'trialLease', 'trialAt']
/** What an earlier version stored and this one retired (merge.ts RETIRED_FIELDS), which every save leaves out. */
const RETIRED = ['purchaseToken', 'purchaseTokenAt', 'claimAskedAt']

/** What a merge is based on, and whether that is about the activation stored or another. */
export function mergeBasis(v: Vector): string {
  if (v.basis === null) return 'unbased'
  const basis = obj(v.basis)
  const kind = Object.keys(basis)[0] ?? 'unbased'
  if (kind === 'trial') return kind
  const about = obj(basis[kind])
  return `${kind}, ${about.activationId === obj(v.latest).activationId ? 'the same activation' : 'another activation'}`
}

/** What else a merge whose patch landed whole did: left out what an earlier version stored, or stamped the launch report. */
function landedNote(v: Vector): string {
  const latest = obj(v.latest)
  if (RETIRED.some((f) => f in latest)) return RETIRED.some((f) => f in obj(v.expect)) ? ', retired fields kept' : ', retired fields left out'
  return 'trialReportedAt' in obj(v.patch) ? ', a report stamped' : ''
}

/** Which rule of `merged` a merge shows, by the fields of its patch that did not land as patched. */
export function mergeOutcome(v: Vector): string {
  const patch = obj(v.patch)
  const result = obj(v.expect)
  // A cleared field (null) landed when the result has none.
  const dropped = Object.keys(patch).filter((f) => (patch[f] === null ? f in result : JSON.stringify(result[f]) !== JSON.stringify(patch[f])))
  if (dropped.length === 0) return `landed whole${landedNote(v)}`
  if (dropped.every((f) => VERDICT.includes(f))) return 'verdict dropped'
  if (dropped.every((f) => TRIAL_ANSWER.includes(f))) return 'trial answer dropped'
  if (dropped.length === 1 && dropped[0] === 'trialStart') return 'trial start kept earliest'
  if (dropped.length === 1 && dropped[0] === 'keptMajor') return 'kept major kept highest'
  return 'trial evidence only'
}

/** How a device name was cut, if it was. */
export function trimOutcome(v: Vector): string {
  const input = String(v.input)
  const out = String(v.expect)
  if (out === input) return 'whole'
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xdc00 && last <= 0xdfff) return 'cut after a pair'
  return out.length === Number(v.max) ? 'cut' : 'cut before a pair'
}

/** The words a validate's refusal is (wire.ts `refusalOf`). */
const REFUSAL_WORDS = ['revoked', 'expired', 'deactivated', 'device', 'upgrade-required', 'update-required']

/** What a renewal vector's answer did (`renewalOutcome`), and the patch it saved. */
const outcome = (v: Vector) => obj(v.expect)
const savedPatch = (v: Vector) => obj(outcome(v).patch)

/** The shape of a validate's body: none, a list, not an object, a refusal word, or another object. */
function renewalBody(json: unknown): string {
  if (json === null || json === undefined) return 'no body'
  if (Array.isArray(json)) return 'a list'
  if (typeof json !== 'object') return 'not an object'
  return REFUSAL_WORDS.includes(String(obj(json).error)) ? 'a refusal word' : 'an object'
}

/** What kind of outcome an answer has: no answer at all, no status, or the status's state. */
function renewalKind(v: Vector): string {
  const o = outcome(v)
  if (o.answered !== true) return 'no answer'
  return o.status === null ? 'no status' : String(obj(o.status).state)
}

/** A renewal's row: the answer's HTTP status and body shape (or none at all), and its kind of outcome. */
function renewalRow(v: Vector): string {
  if (v.response === null) return `no response: ${renewalKind(v)}`
  const response = obj(v.response)
  return `${String(response.status)}, ${renewalBody(response.json)}: ${renewalKind(v)}`
}

/** The status a renewal gives (`statusShape`), or that it gave none. */
function renewalStatus(v: Vector): string {
  const o = outcome(v)
  if (o.answered !== true) return 'no answer'
  return o.status === null ? 'answered, no status' : statusShape(o.status)
}

const WAITS: Record<string, string> = { '60000': 'a minute', '3600000': 'an hour' }

/** The wait a renewal saved: cleared, a minute, an hour, or another. */
function renewalWait(v: Vector): string {
  const ms = savedPatch(v).backoffMs
  if (ms === null) return 'cleared'
  return WAITS[String(ms)] ?? `other: ${String(ms)}`
}

/** What the device read, and whether the patch keyed the install by it. */
function renewalKeyed(v: Vector): string {
  const kind = obj(v.device).kind
  const patch = savedPatch(v)
  const keyed = 'deviceKind' in patch ? `keyed ${String(patch.deviceKind)}` : 'not keyed'
  return `${typeof kind === 'string' ? kind : 'no kind'}: ${keyed}`
}

/** What the patch did to the kept major: left it out, cleared it, kept it, or raised it. */
function renewalKept(v: Vector): string {
  const patch = savedPatch(v)
  if (!('keptMajor' in patch)) return 'untouched'
  if (patch.keptMajor === null) return 'cleared'
  return patch.keptMajor === v.keptMajor ? 'as it was' : 'raised'
}

/** The refusal the patch wrote: none, cleared, or which, with the lease dropped or refused for nobody. */
function renewalRefusal(v: Vector): string {
  const patch = savedPatch(v)
  if (!('refused' in patch)) return 'none written'
  if (patch.refused === null) return 'cleared'
  const dropped = patch.lease === null ? ', the lease dropped' : ''
  const nobody = Array.isArray(patch.refusedFor) && patch.refusedFor.length === 0 ? ', for nobody' : ''
  return `${String(patch.refused)}${dropped}${nobody}`
}

/**
 * The renewals' facets: the rows (each answer by its HTTP status and the shape
 * of its body, and its kind of outcome, so every row of the table, the refusal
 * words where they are no verdict included, keeps a vector), the status
 * (entitlements included), the wait, install memory, the kept major, and the
 * refusal.
 */
export function renewalFacets(): Record<string, Facet> {
  return {
    rows: {
      of: renewalRow,
      expect: [
        '200, a refusal word: no status',
        '200, an object: invalid',
        '200, an object: licensed',
        '200, an object: no status',
        '200, no body: no status',
        '200, not an object: no status',
        '400, an object: no status',
        '401, a refusal word: invalid',
        '403, a list: no status',
        '403, a refusal word: invalid',
        '403, an object: no status',
        '403, no body: no status',
        '403, not an object: no status',
        '404, an object: no status',
        '409, an object: no status',
        '429, a refusal word: no answer',
        '429, an object: no answer',
        '500, an object: no answer',
        '502, a refusal word: no answer',
        '503, no body: no answer',
        'no response: no answer',
      ],
    },
    status: {
      of: renewalStatus,
      expect: [
        'answered, no status',
        'invalid: device',
        'invalid: outdated',
        'invalid: revoked',
        'invalid: upgrade',
        'licensed',
        'licensed, entitled',
        'licensed, test',
        'licensed, test, entitled',
        'no answer',
      ],
    },
    wait: { of: renewalWait, expect: ['a minute', 'an hour', 'cleared'] },
    keyed: { of: renewalKeyed, expect: ['hostname: not keyed', 'machine: keyed machine', 'no kind: not keyed'] },
    kept: { of: renewalKept, expect: ['as it was', 'cleared', 'raised', 'untouched'] },
    refusal: {
      of: renewalRefusal,
      expect: ['cleared', 'device', 'device, for nobody', 'none written', 'outdated', 'revoked, the lease dropped', 'upgrade'],
    },
  }
}
