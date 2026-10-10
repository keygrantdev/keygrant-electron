/**
 * A payment link with a reference of this install's on it: `upgradeUrl`'s
 * (license.ts), which names the activation an upgrade sale finds the key by.
 */

/** The query parameter a payment link names its checkout's buyer by. */
const REFERENCE = 'client_reference_id'

/** A payment link read as an absolute URL; a TypeError for anything else (a path, a bare host). */
export function absoluteLink(link: string): URL {
  return new URL(link)
}

/**
 * `link` with `reference` as its one `client_reference_id`. The link is read
 * as an absolute URL (`absoluteLink`), which writes it in its normal form,
 * and its query is then edited as text: every parameter named exactly
 * `client_reference_id` (its text before the first `=`, or all of it) and
 * every empty one is left out, the others are kept as written and in their
 * order, and `client_reference_id=<reference>` (percent-encoded as a URI
 * component) is added last. The fragment is kept.
 */
export function referencedLink(link: string, reference: string): string {
  const url = absoluteLink(link)
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== REFERENCE)
  url.search = [...kept, `${REFERENCE}=${encodeURIComponent(reference)}`].join('&')
  return url.href
}
