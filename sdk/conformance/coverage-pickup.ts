/**
 * What each key-pickup group (`PickupGroup`) must cover, as `coverage.ts` says
 * of the others: every outcome its decision gives keeps a vector.
 */
import type { PickupGroup } from './inputs.js'
import { obj, type Facet, type Vector } from './facets.js'

/** The longest address. */
const MAX_EMAIL = 254

/** How an address was typed. */
function emailInput(v: Vector): string {
  const email = String(v.email)
  const trimmed = email.trim()
  if (trimmed === '') return 'blank'
  if (trimmed.length > MAX_EMAIL) return 'too long'
  if (trimmed.length === MAX_EMAIL) return 'at the limit'
  return email === trimmed ? 'as typed' : 'trimmed'
}

/** How a code was typed. */
function codeInput(v: Vector): string {
  const code = v.code
  if (typeof code !== 'string') return 'none'
  if (code.trim() === '') return 'blank'
  if (/^[0-9]{6}$/.test(code)) return 'six digits as typed'
  return /^[0-9]{6}$/.test(code.trim().split(' ').join('')) ? 'six digits trimmed or spaced' : 'not six digits'
}

/** What a pickup call sends, or why it refuses. */
function askOutcome(v: Vector): string {
  const expect = obj(v.expect)
  if ('refused' in expect) return `refused ${String(expect.refused)}`
  return 'code' in obj(expect.send) ? 'sends the address and the code' : 'sends the address'
}

/** Which of the server's words a refused body carries. */
function refusalWord(v: Vector): string {
  const error = obj(v.json).error
  if (typeof error !== 'string') return 'no text word'
  if (['pickup-disabled', 'wrong-code', 'code-expired', 'too-many-attempts', 'try-again'].includes(error)) return 'a pickup word'
  return ['rate-limited', 'unavailable', 'invalid-request'].includes(error) ? error : 'another word'
}

/** Whether a refusal's wait was kept, given and dropped, or not given. */
function refusalWait(v: Vector): string {
  if ('retryAfter' in obj(v.expect)) return 'kept'
  return 'retryAfter' in obj(v.json) ? 'given and dropped' : 'none given'
}

/** The members of a confirm's body, and the keys read of it. */
function keysOf(v: Vector): { given: unknown[]; read: Record<string, unknown>[] | null } {
  const given = obj(v.json).keys
  return { given: Array.isArray(given) ? given : [], read: Array.isArray(v.expect) ? (v.expect as Record<string, unknown>[]) : null }
}

/** A field of a body with one member, as given and as read, or null for any other body. */
function onlyMember(v: Vector): { given: Record<string, unknown>; read: Record<string, unknown> } | null {
  const { given, read } = keysOf(v)
  return given.length === 1 && read?.length === 1 ? { given: obj(given[0]), read: obj(read[0]) } : null
}

/** How a member's optional field was read: kept, dropped, or not given. */
function optional(field: string): (v: Vector) => string {
  return (v) => {
    const one = onlyMember(v)
    if (!one || !(field in one.given)) return 'not given'
    return field in one.read ? 'kept' : 'dropped'
  }
}

/** How a member's versions were read. */
function versionsRead(v: Vector): string {
  const one = onlyMember(v)
  if (!one || !('versions' in one.given)) return 'not given'
  if (one.read.versions === null) return one.given.versions === null ? 'null as given' : 'unreadable, none'
  return JSON.stringify(one.read.versions) === JSON.stringify(one.given.versions) ? 'read as given' : 'read, members fallen back'
}

/** The key a choice picked, by why it was picked, or the refusal. */
function choiceOutcome(v: Vector): string {
  const expect = obj(v.expect)
  if ('refused' in expect) return String(expect.refused)
  const key = obj((v.keys as unknown[])[Number(expect.index)])
  if (key.held === true) return 'the held key'
  return Number(key.activeDevices) < Number(key.deviceLimit) ? 'a key with a free seat' : 'the first that covers'
}

/** What made the chosen key cover the build. */
function coveredBy(v: Vector): string {
  const expect = obj(v.expect)
  if ('refused' in expect) return 'none'
  const versions = obj((v.keys as unknown[])[Number(expect.index)]).versions
  if (versions === null) return 'not yet bound'
  const { minMajor, maxMajor } = obj(versions) as { minMajor: number; maxMajor: number | null }
  const major = Number(v.major)
  if (maxMajor !== null && major > maxMajor) return 'an open upgrade window'
  if (maxMajor === null) return 'no top'
  if (minMajor < maxMajor) return major === maxMajor ? 'the top of a range' : major === minMajor ? 'the bottom of a range' : 'inside a range'
  return 'one major'
}

export const PICKUP_COVERAGE: Record<PickupGroup, Record<string, Facet>> = {
  pickupAsks: {
    outcome: {
      of: askOutcome,
      expect: ['refused invalid-email', 'refused wrong-code', 'sends the address', 'sends the address and the code'],
    },
    email: { of: emailInput, expect: ['as typed', 'at the limit', 'blank', 'too long', 'trimmed'] },
    code: { of: codeInput, expect: ['blank', 'none', 'not six digits', 'six digits as typed', 'six digits trimmed or spaced'] },
    // A vector with an address and a code both refused shows the address is judged first.
    order: {
      of: (v) =>
        ['blank', 'too long'].includes(emailInput(v)) && ['blank', 'not six digits'].includes(codeInput(v)) ? 'both refused, the address first' : 'one or none',
      expect: ['both refused, the address first', 'one or none'],
    },
  },
  pickupRefusals: {
    error: {
      of: (v) => String(obj(v.expect).error),
      expect: ['code-expired', 'invalid-email', 'network', 'pickup-disabled', 'too-many-attempts', 'try-again', 'wrong-code'],
    },
    word: { of: refusalWord, expect: ['a pickup word', 'another word', 'invalid-request', 'no text word', 'rate-limited', 'unavailable'] },
    wait: { of: refusalWait, expect: ['given and dropped', 'kept', 'none given'] },
  },
  pickedKeys: {
    outcome: {
      of: (v) => (v.expect === null ? 'no answer' : (v.expect as unknown[]).length === 0 ? 'no keys' : 'keys'),
      expect: ['keys', 'no answer', 'no keys'],
    },
    members: {
      of: (v) => {
        const { given, read } = keysOf(v)
        return read !== null && read.length < given.length ? 'leaves a member out' : 'leaves none out'
      },
      expect: ['leaves a member out', 'leaves none out'],
    },
    versions: { of: versionsRead, expect: ['not given', 'null as given', 'read as given', 'read, members fallen back', 'unreadable, none'] },
    held: {
      of: (v) => {
        const one = onlyMember(v)
        if (!one || !('held' in one.given)) return 'not given'
        return one.read.held === true ? 'true' : 'false'
      },
      expect: ['false', 'not given', 'true'],
    },
    sale: { of: optional('sale'), expect: ['dropped', 'kept', 'not given'] },
    activationCode: { of: optional('activationCode'), expect: ['dropped', 'kept', 'not given'] },
  },
  pickupChoices: {
    outcome: {
      of: choiceOutcome,
      expect: ['a key with a free seat', 'no-key', 'outdated', 'the first that covers', 'the held key', 'upgrade'],
    },
    covered: {
      of: coveredBy,
      expect: ['an open upgrade window', 'no top', 'none', 'not yet bound', 'one major', 'the bottom of a range', 'the top of a range'],
    },
  },
}
