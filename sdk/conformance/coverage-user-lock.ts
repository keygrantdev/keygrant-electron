/**
 * What each user-lock group (`UserLockGroup`) must cover, as `coverage.ts`
 * says of the others: every outcome its decision gives keeps a vector.
 */
import type { UserLockGroup } from './inputs.js'
import { answer, obj, type Facet, type Vector } from './facets.js'

/** What `typedFor` sends, or why it refuses. */
function typedOutcome(v: Vector): string {
  const expect = obj(v.expect)
  if ('refused' in expect) return `refused ${String(expect.refused)}`
  const sent = Object.keys(obj(expect.send)).sort()
  return sent.length === 0 ? 'sends neither' : `sends ${sent.join(' and ')}`
}

/** How an address was typed. */
function emailInput(v: Vector): string {
  const email = v.email
  if (typeof email !== 'string') return 'none'
  if (email.trim() === '') return 'blank'
  if (email.trim().length > 254) return 'too long'
  return email === email.trim() ? 'as typed' : 'trimmed'
}

/** How a code was typed. */
function codeInput(v: Vector): string {
  const code = v.code
  if (typeof code !== 'string') return 'none'
  if (code.trim() === '') return 'blank'
  if (/^[0-9]{6}$/.test(code)) return 'six digits as typed'
  return /^[0-9]{6}$/.test(code.trim().split(' ').join('')) ? 'six digits trimmed or spaced' : 'not six digits'
}

/** Whether every character is ASCII. */
const isAscii = (text: string): boolean => [...text].every((c) => (c.codePointAt(0) ?? 0) < 0x80)

/**
 * Where an address sits against the limit once trimmed, in UTF-16 units, and what its characters are: ASCII,
 * BMP letters past ASCII (over the limit in bytes already at 254 units), or an astral pair (two units),
 * which straddles the limit at 255. Only the two units either side of the limit are told apart.
 */
function emailLimit(v: Vector): string {
  const email = v.email
  if (typeof email !== 'string') return 'none'
  const trimmed = email.trim()
  const units = trimmed.length
  if (units !== 254 && units !== 255) return 'away from the limit'
  const kind = /[\ud800-\udbff][\udc00-\udfff]/.test(trimmed) ? 'astral' : isAscii(trimmed) ? 'ASCII' : 'BMP non-ASCII'
  return `${kind} at ${units} units`
}

/** The white space JavaScript's trim takes off, by name: the ones the vectors use. */
const TRIMMED_SPACES: Record<string, string> = {
  ' ': 'space',
  '\t': 'tab',
  '\n': 'newline',
  '\r': 'carriage return',
  '\ufeff': 'byte-order mark',
  '\u00a0': 'no-break space',
  '\u2003': 'em space',
  '\u3000': 'ideographic space',
  '\u2028': 'line separator',
}

/**
 * What the trim took off the ends of a typed value, by name: nothing, or each kind of white space, ASCII or
 * not (the byte-order mark among them, which .NET's and Rust's own trims leave).
 */
function endsLost(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'none or blank'
  const lost = value.slice(0, value.length - value.trimStart().length) + value.slice(value.trimEnd().length)
  if (lost === '') return 'nothing lost'
  const kinds = new Set([...lost].map((c) => TRIMMED_SPACES[c] ?? (isAscii(c) ? 'other ASCII white space' : 'another non-ASCII space')))
  return `${[...kinds].sort().join(' and ')} lost`
}

/** The spaces (other than U+0020) a code is told apart by, and what is made of them. */
const OTHER_SPACES: Record<string, string> = { '\u00a0': 'no-break space', '\u2003': 'em space', '\t': 'tab', '\n': 'newline' }

/**
 * What lies inside a code once its ends are trimmed: U+0020 (dropped), any other white space (refused, each
 * told apart), or digits of another script (refused, each script told apart), with whether the code was sent.
 */
function codeInside(v: Vector): string {
  const code = v.code
  if (typeof code !== 'string') return 'none'
  const inside = code.trim()
  if (inside === '') return 'blank'
  const fate = 'send' in obj(v.expect) ? 'sent' : 'refused'
  const other = /[^\S ]/.exec(inside)?.[0]
  if (other !== undefined) return `${OTHER_SPACES[other] ?? 'another space'} inside, ${fate}`
  if (inside.includes(' ')) return `U+0020 inside, ${fate}`
  if (/^\p{Nd}+$/u.test(inside) && !/^[0-9]+$/.test(inside)) {
    const script = /^[\uff10-\uff19]+$/.test(inside) ? 'fullwidth' : /^[\u0660-\u0669]+$/.test(inside) ? 'Arabic-Indic' : 'other'
    return `${script} digits, ${fate}`
  }
  return 'no space inside'
}

export const USER_LOCK_COVERAGE: Record<UserLockGroup, Record<string, Facet>> = {
  typedFor: {
    outcome: { of: typedOutcome, expect: ['refused user-code-invalid', 'refused user-email-mismatch', 'sends code', 'sends code and email', 'sends email', 'sends neither'] },
    email: { of: emailInput, expect: ['as typed', 'blank', 'none', 'too long', 'trimmed'] },
    // The edge of the limit, in units, for each kind of character: a port that counts bytes, code points or
    // characters instead of UTF-16 units fails one of these.
    emailLimit: {
      of: emailLimit,
      expect: [
        'ASCII at 254 units',
        'ASCII at 255 units',
        'BMP non-ASCII at 254 units',
        'BMP non-ASCII at 255 units',
        'astral at 254 units',
        'astral at 255 units',
        'away from the limit',
        'none',
      ],
    },
    // The trim is JavaScript's, not ASCII's: a non-ASCII space at the ends of an address or a code goes too, each
    // kind told apart (the byte-order mark is the one a port's own trim is likeliest to leave), as do the tab
    // and carriage return a paste carries.
    emailEnds: {
      of: (v) => endsLost(v.email),
      expect: [
        'byte-order mark lost',
        'carriage return and newline and tab lost',
        'em space and no-break space lost',
        'ideographic space and line separator lost',
        'newline and space lost',
        'none or blank',
        'nothing lost',
        'space lost',
      ],
    },
    codeEnds: {
      of: (v) => endsLost(v.code),
      expect: ['em space and ideographic space lost', 'newline and space lost', 'no-break space lost', 'none or blank', 'nothing lost', 'space lost'],
    },
    // Only U+0020 is dropped inside a code: any other space, and any digit but 0 to 9, refuses it.
    codeInside: {
      of: codeInside,
      expect: [
        'Arabic-Indic digits, refused',
        'blank',
        'em space inside, refused',
        'fullwidth digits, refused',
        'newline inside, refused',
        'no space inside',
        'no-break space inside, refused',
        'none',
        'tab inside, refused',
        'U+0020 inside, sent',
      ],
    },
    // A vector with both an address and a code that cannot be sent shows the address is judged first.
    order: {
      of: (v) => (emailInput(v) === 'too long' && codeInput(v) === 'not six digits' ? 'both refused, the address first' : 'one or none'),
      expect: ['both refused, the address first', 'one or none'],
    },
    code: { of: codeInput, expect: ['blank', 'none', 'not six digits', 'six digits as typed', 'six digits trimmed or spaced'] },
  },
  userLockErrors: {
    answer: {
      of: answer,
      expect: [
        '"limit"',
        '"network"',
        '"too-many-attempts"',
        '"too-many-codes"',
        '"try-again"',
        '"user-code-invalid"',
        '"user-code-required"',
        '"user-email-mismatch"',
        '"user-email-required"',
      ],
    },
  },
}
