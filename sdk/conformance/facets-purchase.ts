/**
 * How `coverage-purchase.ts` tells apart the vectors of the purchase groups
 * (`LaterGroup`): each names the rule a vector exists for, so that deleting a
 * rule's only vector fails the coverage check.
 */
import { obj, type Vector } from './facets.js'

const DAY_MS = 86_400_000
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

/** Which rule of `referencedLink` a payment link shows (`purchaseUrls`). */
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

/** Which clock decides a `claimDue` vector whose guarded clock is not the device clock. */
export function claimDueClocks(v: Vector): string {
  if (v.now === v.clockNow) return 'one time'
  if (v.expect === true) return 'two clocks: due'
  const at = obj(v.state).purchaseTokenAt
  const stale = typeof at === 'number' && Number(v.now) - at >= DAY_MS
  return stale ? 'two clocks: stale by the guarded clock' : 'two clocks: waiting by the device clock'
}

/** Why `parseClaimBody` kept what it kept, or left out what it left out. */
export function parseRule(v: Vector): string {
  const body = v.body
  if (body === null) return 'null'
  if (Array.isArray(body)) return 'an array'
  if (typeof body !== 'object') return typeof body === 'string' ? 'a string' : 'a number'
  const b = body as Record<string, unknown>
  const members = Object.keys(b)
  if (members.length === 0) return 'an empty object'
  if ('error' in b) return typeof b.error !== 'string' ? 'an error not a string' : b.error === '' ? 'an empty error' : 'an error word'
  if ('pending' in b) return b.pending === true ? 'pending true' : b.pending === false ? 'pending false' : 'pending not true'
  const strings = ['key', 'activationId', 'lease'].filter((m) => typeof b[m] === 'string')
  if (strings.length === 0) return 'members not strings'
  return members.length > strings.length ? 'unknown members ignored' : 'members kept one by one'
}

/** Which row of `claimOutcome` a claim's answer is, from its response and check (`claimOutcomes`). */
export function claimRow(v: Vector): string {
  if (v.response === null) return 'no answer'
  const { status, json } = obj(v.response) as { status: number; json: unknown }
  const body = obj(json)
  const word = typeof body.error === 'string' && body.error !== ''
  if (status >= 500) return word ? 'a 5xx with an error word' : 'a 5xx'
  if (status === 429) return 'a 429'
  const full = ['key', 'activationId', 'lease'].every((member) => typeof body[member] === 'string')
  if (status === 200 && full) {
    if (obj(v.check).ok !== true) return '200, a key: does not license'
    return body.pending === true ? '200, a key, also pending' : word ? '200, a key, also an error word' : '200, a key: licenses'
  }
  if (status === 200 && body.pending === true) return '200, pending'
  if (status === 200 && 'pending' in body) return '200, pending not true'
  if (status === 200 && typeof body.key === 'string' && typeof body.lease === 'string') return '200, key and lease without an activation'
  if (body.error === '') return 'an empty error'
  if (word) return `${status === 200 ? '200' : 'another status'}, an error word`
  const shape = typeof json === 'object' && json !== null ? 'no error word' : 'not JSON'
  return `${status === 200 ? '200' : 'another status'}, ${shape}`
}

/** The status a claim gives: none, or licensed with what it carries. */
export function claimStatus(v: Vector): string {
  const status = obj(obj(v.expect).status)
  if (status.state === undefined) return 'no status'
  return [String(status.state), ...(status.test === true ? ['test'] : []), ...(status.entitlements ? ['entitled'] : [])].join(', ')
}

/** The kept major a bought key saves (`keptWith` from none): none, or the build. */
export function claimKept(v: Vector): string {
  const e = obj(v.expect)
  if (e.result !== 'bought') return 'not bought'
  return obj(e.patch).keptMajor === null ? 'bought, no kept major' : 'bought, the build kept'
}

/** Who a claim is sent under (`claimRequest`), or why nothing is sent. */
export function claimBodySent(v: Vector): string {
  if (v.expect === null) return `nothing sent, ${v.start === true ? 'startTrial' : 'status'}`
  const kind = obj(v.expect).fingerprintKind
  if (kind === 'hostname') return obj(v.identity).fingerprint === null ? 'sent, the host-name fallback at startTrial' : 'sent, the host name read'
  if (typeof kind === 'string') return `sent, ${kind}`
  return `sent, no kind, ${v.deviceHold === true ? 'held' : 'not held'}`
}

/** Whether a claim's `fingerprints` hold every fingerprint read, held or not, its own read or not (`claimRequest`). */
export function claimBodyFingerprints(v: Vector): string {
  if (v.expect === null) return 'nothing sent'
  const identity = obj(v.identity)
  const read = [identity.fingerprint, ...(Array.isArray(identity.alternates) ? identity.alternates : [])].filter((f) => f !== null)
  const sent = obj(v.expect).fingerprints
  const all = (Array.isArray(sent) ? sent.length : 0) === read.length ? 'every one read' : 'some left out'
  const held = v.deviceHold === true ? 'held' : 'not held'
  return `${all}, ${held}, ${identity.fingerprint === null ? 'its own not read' : 'its own read'}`
}

/** Which bound on a claim's `fingerprints` a vector shows (`claimRequest`). */
export function claimBodyBound(v: Vector): string {
  if (v.expect === null) return 'nothing sent'
  const identity = obj(v.identity)
  const own = typeof identity.fingerprint === 'string' ? identity.fingerprint : null
  const alternates = (Array.isArray(identity.alternates) ? identity.alternates : []).map(String).filter((f) => f !== own)
  const read = [...(own !== null ? [own] : []), ...alternates]
  if (own !== null && own.length > 200) return 'its own too long'
  if (read.some((f) => f.length > 200 && [...f].length <= 200)) return 'counted in UTF-16 units'
  if (read.some((f) => f.length > 200)) return 'too long'
  if (read.some((f) => f === '')) return 'empty'
  return read.length > 4 ? 'over four' : 'within the bounds'
}
