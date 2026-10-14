/**
 * The compact JWS core a lease and a licence file share: base64url as every
 * signed token here is written (RFC 4648 section 5, no padding), the form of a
 * key id, the key id a header names (matched as bytes), and Ed25519 signing.
 * Not exported from the package: the signers and verifiers in this folder are
 * its only users.
 */

/** The WebCrypto algorithm every token here is signed with. */
export const ALG = { name: 'Ed25519' } as const

const enc = new TextEncoder()

/**
 * An id of the form a key id takes: 1 to 64 characters of the base64url
 * alphabet (a thumbprint is 43). A licence file's id (`fid`) takes the same form.
 */
export const KID = /^[A-Za-z0-9_-]{1,64}$/

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode CANONICAL base64url: the URL-safe alphabet, no padding, and nothing
 * the encoder above would not have written (`b64urlEncode` of the result gives
 * the input back). Anything else throws.
 *
 * Strict on purpose. `atob` forgives padding, the standard alphabet and stray
 * bits in the last character, so one signature would have several spellings
 * that all verify, and an SDK in another language with a strict decoder would
 * refuse tokens this one accepts. Every token the server signs is canonical,
 * so only a token nobody issued is refused by this.
 */
export function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) throw new Error('not base64url')
  const s = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const bin = atob(s + '='.repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if (b64urlEncode(out) !== input) throw new Error('not canonical base64url')
  return out
}

/** A segment (a header or a payload) as written: canonical base64url of the UTF-8 of `text`. */
export function segmentOf(text: string): string {
  return b64urlEncode(enc.encode(text))
}

/**
 * The key id a header names when it is, byte for byte, canonical base64url of
 * `<start><kid>"}`, `<kid>` of the form `KID`; undefined for any other header.
 * Matched as bytes, never parsed, so no two JSON readers can disagree about
 * what a header names: each byte is one character, so a byte past ASCII
 * matches nothing.
 */
export function namedKeyId(header: string, start: string): string | undefined {
  let text = ''
  try {
    for (const byte of b64urlDecode(header)) text += String.fromCharCode(byte)
  } catch {
    return undefined
  }
  if (!text.startsWith(start) || !text.endsWith('"}')) return undefined
  const kid = text.slice(start.length, text.length - 2)
  return KID.test(kid) ? kid : undefined
}

/** A compact JWS of `header` and `payload` (each written as given), signed by `key`. */
export async function signCompact(header: string, payload: string, key: CryptoKey): Promise<string> {
  const signingInput = `${segmentOf(header)}.${segmentOf(payload)}`
  const signature = new Uint8Array(await crypto.subtle.sign(ALG, key, enc.encode(signingInput)))
  return `${signingInput}.${b64urlEncode(signature)}`
}
