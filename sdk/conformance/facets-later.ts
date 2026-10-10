/**
 * How `coverage-later.ts` tells apart the vectors of the groups after the
 * first ones (`LaterGroup`): each names the rule a vector exists for, so that
 * deleting a rule's only vector fails the coverage check.
 */
import type { Vector } from './facets.js'

const REFERENCE = 'client_reference_id'

/** How a configured major is read (`majorOf`), and what it reads as. */
export function majorRead(v: Vector): string {
  const configured = v.configured
  if (configured === null) return `absent -> ${String(v.expect)}`
  const n = Number(configured)
  let kind: string
  if (!Number.isInteger(n)) kind = n < 0 ? 'a negative fraction' : n < 1 ? 'a fraction under 1' : 'a fraction over 1'
  else kind = n === 0 ? '0' : n < 0 ? 'a negative' : n === 1 ? '1' : 'over 1'
  return `${kind} -> ${v.expect === n ? 'as it is' : String(v.expect)}`
}

/** Which rule of `referencedLink` a payment link shows (`referencedLinks`). */
export function linkRule(v: Vector): string {
  const link = String(v.link)
  const [beforeFragment = '', fragment] = link.split('#')
  if (!beforeFragment.includes('?')) return fragment === undefined ? 'no query' : 'a fragment, no query'
  if (fragment !== undefined) return 'a fragment after parameters'
  const query = beforeFragment.slice(beforeFragment.indexOf('?') + 1)
  if (query === '') return 'an empty query'
  const parts = query.split('&')
  const named = parts.filter((part) => part.split('=')[0] === REFERENCE)
  if (named.length > 1) return 'two client_reference_ids'
  if (named.some((part) => part === REFERENCE)) return 'a bare client_reference_id'
  if (named.length === 1) return 'a client_reference_id'
  if (parts.some((part) => part === '')) return 'empty parameters'
  if (parts.some((part) => part.startsWith(REFERENCE))) return 'a name only starting with client_reference_id'
  if (parts.some((part) => part.indexOf('=') !== part.lastIndexOf('='))) return 'an = in a value'
  return /:\d+\//.test(beforeFragment) ? 'a port and a deeper path' : 'other parameters'
}

/** Where a stored stamp falls against the time judged at: none, ahead, or how far inside or past `bound`. */
export function stampEdge(stamp: unknown, at: number, bound: number): string {
  if (typeof stamp !== 'number') return 'none'
  if (stamp > at) return 'ahead'
  const age = at - stamp
  if (age === bound - 1) return 'a millisecond inside'
  if (age === bound) return 'at the bound'
  return age < bound ? 'inside' : 'past'
}
