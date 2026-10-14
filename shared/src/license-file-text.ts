import { OPEN_MAJOR } from './lease.js'
import { b64urlDecode } from './jws.js'
import { CONTROLS } from './text.js'

/**
 * A licence file as it is saved and sent: UTF-8 text holding its token on a
 * line of its own, with `#` lines for a person who opens it (the product, who
 * it is licensed to, what it covers). Only the token is read: the `#` lines
 * are notes, never trusted, and a token pasted alone is a licence file too.
 */

/** The most a licence file may be, in bytes. A real one is well under 2 KB. */
export const MAX_LICENSE_FILE_BYTES = 16_384

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** Space, tab and carriage return: what is trimmed from each end of a line. */
const LINE_EDGES = /^[ \t\r]+|[ \t\r]+$/g

/**
 * The token a licence file holds, or null when it is no licence file's
 * container: more than MAX_LICENSE_FILE_BYTES; not UTF-8; or not exactly one
 * line once each line (split on LF) is trimmed of spaces, tabs and carriage
 * returns, and empty lines and lines starting with `#` are left out. A
 * leading byte-order mark is ignored. Text is read as its UTF-8 bytes, so a
 * file handed over as text or as bytes reads the same. Whether the token is a
 * licence file's at all is `verifyLicenseFile`'s to say.
 */
export function licenseFileToken(content: string | Uint8Array | ArrayBuffer): string | null {
  // A text longer in UTF-16 units than the bound is longer in UTF-8 bytes too: never encoded.
  if (typeof content === 'string' && content.length > MAX_LICENSE_FILE_BYTES) return null
  const bytes = bytesOf(content)
  if (bytes === null || bytes.length > MAX_LICENSE_FILE_BYTES) return null
  let text: string
  try {
    // Strict, and a leading byte-order mark dropped (TextDecoder's default).
    text = strictUtf8.decode(bytes)
  } catch {
    return null
  }
  const lines = text
    .split('\n')
    .map((line) => line.replace(LINE_EDGES, ''))
    .filter((line) => line !== '' && !line.startsWith('#'))
  return lines.length === 1 ? (lines[0] as string) : null
}

/**
 * A file's content as bytes: text as its UTF-8, a byte array (a Node Buffer
 * included) as it is, an ArrayBuffer (what a dropped `File` gives) whole; null
 * for anything else. By tag rather than `instanceof`, so an array made in
 * another realm (an Electron renderer, a worker) is read too.
 */
function bytesOf(content: unknown): Uint8Array | null {
  if (typeof content === 'string') return utf8.encode(content)
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
  if (Object.prototype.toString.call(content) === '[object ArrayBuffer]') return new Uint8Array(content as ArrayBuffer)
  return null
}

/** A claim as a note line shows it: on one line, whatever it holds. */
const oneLine = (value: unknown) => String(value).replace(CONTROLS, ' ')

/** What a file's versions read as, for a person. */
function versionsOf(minMajor: number, major: number): string {
  if (major >= OPEN_MAJOR) return minMajor <= 1 ? 'every version' : `${minMajor} and later`
  return minMajor === major ? `${major}` : `${minMajor} to ${major}`
}

/**
 * The text of the file a licence file's token is sent as: its notes, then the
 * token. Reads the token's own claims (unverified: the signer's output) for
 * the notes. Throws for a token whose payload is not a licence file's JSON, and
 * for a file past MAX_LICENSE_FILE_BYTES, which no SDK would read.
 */
export function licenseFileText(token: string): string {
  const payload = token.split('.')[1] ?? ''
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Record<string, unknown>
  if (claims.kind !== 'key' && claims.kind !== 'offline') throw new Error('not a licence file')
  const to = [claims.name, claims.email !== undefined ? `<${String(claims.email)}>` : undefined].filter((part) => part !== undefined)
  const notes = [
    claims.kind === 'key' ? 'KeyGrant license key file' : 'KeyGrant license file',
    `Product: ${oneLine(claims.product)}`,
    `Licensed to: ${oneLine(to.join(' '))}`,
    ...(claims.kind === 'offline' ? [`Versions: ${versionsOf(Number(claims.minMajor ?? 1), Number(claims.major))}`] : []),
    ...(claims.kind === 'key' ? [`License key: ${oneLine(claims.sub)}`] : []),
    ...(claims.test === true ? ['A test license, for the developer\'s own testing.'] : []),
    'To use it, drop this file onto the app, or open it from the app\'s license screen.',
    'Only the last line is read. These notes are not, and changing them changes nothing.',
  ]
  const text = `${notes.map((note) => `# ${note}`).join('\n')}\n${token}\n`
  if (utf8.encode(text).length > MAX_LICENSE_FILE_BYTES) throw new Error('a licence file past MAX_LICENSE_FILE_BYTES, which no SDK would read')
  return text
}
