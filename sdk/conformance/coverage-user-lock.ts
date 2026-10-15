/**
 * What each user-lock group (`UserLockGroupName`) must cover, as `coverage.ts`
 * says of the others: every outcome its decision gives keeps a vector.
 */
import type { UserLockGroupName } from './inputs.js'
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

export const USER_LOCK_COVERAGE: Record<UserLockGroupName, Record<string, Facet>> = {
  typedFor: {
    outcome: { of: typedOutcome, expect: ['refused user-code-invalid', 'refused user-email-mismatch', 'sends code', 'sends code and email', 'sends email', 'sends neither'] },
    email: { of: emailInput, expect: ['as typed', 'blank', 'none', 'too long', 'trimmed'] },
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
