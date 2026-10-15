/**
 * The user-lock groups (the SDK contract, section 11): what `activate`
 * sends for what a person typed for a user-locked key (`typedFor`), and the
 * words the server refuses a new device with (`mapServerError`).
 */
import { MAX_EMAIL } from '../../src/wire.js'
import type { UserLockGroupInputs } from '../inputs.js'

/** An address of exactly `length` characters. */
function addressOf(length: number): string {
  const tail = '@studio.example'
  return `${'a'.repeat(length - tail.length)}${tail}`
}

export function typedFor(): UserLockGroupInputs['typedFor'][] {
  const email = 'Mara@Studio.example'
  const pairs: [string | null, string | null][] = [
    [null, null],
    // The address alone: as typed, trimmed of what a paste carries, and none when blank.
    [email, null],
    ['mara@studio.example', null],
    ['  Mara@Studio.example\n', null],
    ['\tMara@Studio.example\r\n', null],
    ['\uFEFFMara@Studio.example', null],
    ['', null],
    ['   ', null],
    ['\n', null],
    // The longest address, measured after the trim.
    [addressOf(MAX_EMAIL), null],
    [` ${addressOf(MAX_EMAIL)} `, null],
    [addressOf(MAX_EMAIL + 1), null],
    // Measured in UTF-16 units, not bytes or code points: BMP letters past ASCII, and an astral character straddling the limit.
    ['é'.repeat(MAX_EMAIL), null],
    ['é'.repeat(MAX_EMAIL + 1), null],
    [`${'a'.repeat(MAX_EMAIL - 2)}\u{1F600}`, null],
    [`${'a'.repeat(MAX_EMAIL - 1)}\u{1F600}`, null],
    // Trimmed as a key is: every Unicode space and the line terminators, not only ASCII ones.
    [' mara@studio.example ', null],
    ['　mara@studio.example ', null],
    ['  　', null],
    // The code alone: six digits, with the spaces a person types between them.
    [null, '123456'],
    [null, '000042'],
    [null, ' 123456\n'],
    [null, '123 456'],
    [null, '1 2 3 4 5 6'],
    [null, ' 123 456 '],
    [null, ''],
    [null, '  '],
    // Its ends trimmed as a key's are (every Unicode space), but only U+0020 dropped inside.
    [null, ' 123456 '],
    [null, '　123 456 '],
    [null, '123 456'],
    [null, '123 456'],
    // Not a code: too few, too many, not digits, other separators, other scripts.
    [null, '12345'],
    [null, '1234567'],
    [null, '12345a'],
    [null, 'abcdef'],
    [null, '123-456'],
    [null, '123\t456'],
    [null, '123\n456'],
    [null, '１２３４５６'],
    [null, '١٢٣٤٥٦'],
    [null, '+12345'],
    [null, '1e5555'],
    [null, '0x1234'],
    // Both, and which is judged first.
    [email, '123456'],
    ['  mara@studio.example ', ' 123 456 '],
    [email, '12345'],
    [addressOf(MAX_EMAIL + 1), '123456'],
    [addressOf(MAX_EMAIL + 1), 'nope'],
    ['', '123456'],
    [email, ''],
  ]
  return pairs.map(([e, c]) => ({ email: e, code: c }))
}

const USER_LOCK_WORDS = [
  'user-email-required',
  'user-email-mismatch',
  'user-code-required',
  'user-code-invalid',
  'too-many-codes',
  'too-many-attempts',
  'try-again',
]

export function userLockErrors(): UserLockGroupInputs['userLockErrors'][] {
  // The old words still read as they did, the unknown as a network failure, and none of the near misses as a word.
  const others = ['limit', 'rate-limited', 'unavailable', 'too-many-requests', 'user-code', 'User-Code-Invalid', 'try_again', 'something-new']
  return [...USER_LOCK_WORDS, ...others, null, 42].map((error) => ({ error }))
}
