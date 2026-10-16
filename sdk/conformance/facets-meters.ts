/**
 * How `coverage-meters.ts` tells apart the vectors of the metered-uses groups (`MeterGroup`): each
 * names the rule a vector exists for, from its inputs and what it shows, so that deleting any one vector
 * fails the coverage check (`src/conformance.test.ts` holds every `rule` to one vector).
 */
import { MAX_METER_USES } from '@keygrant/shared'
import { ASK_AGAIN_MS, RETRY_UNANSWERED_MS } from '../src/offline.js'
import { PENDING_MAX_MS } from '../src/meters.js'
import { leaseVerdict, obj, payloadOf, type Vector } from './facets.js'

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** How a JSON number sits among the whole numbers a figure may be. */
function figureForm(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (typeof value !== 'number') return Array.isArray(value) ? 'a list' : typeof value === 'string' ? 'a text' : 'a flag'
  if (!Number.isFinite(value)) return 'out of range'
  if (!Number.isInteger(value)) return value < 0 ? 'a negative fraction' : 'a fraction'
  if (value < 0) return 'negative'
  if (value === 0) return 'zero'
  if (value > Number.MAX_SAFE_INTEGER) return 'past 2^53 - 1'
  if (value === Number.MAX_SAFE_INTEGER) return '2^53 - 1'
  return value > MAX_METER_USES ? 'past the cap' : 'whole'
}

/** What a meter's name is, when it is not an ordinary one. */
function nameForm(code: string): string {
  if (code === '__proto__' || code === 'constructor') return code
  if (code === '') return 'an empty name'
  return /[^\x20-\x7e]/.test(code) ? 'a name beyond ASCII' : 'a name'
}

/** One member of a `met` claim, by what is wrong with it, if anything. */
function memberRule(code: string, member: unknown): string {
  const name = nameForm(code)
  if (typeof member !== 'object' || member === null || Array.isArray(member)) {
    return `${name}: ${member === null ? 'null' : Array.isArray(member) ? 'a list' : typeof member === 'string' ? 'a text' : 'a number'}`
  }
  const m = obj(member)
  const figures = [m.left, m.total, m.offline].map(figureForm)
  const plain = figures.every((f) => f === 'whole')
  const above = typeof m.left === 'number' && typeof m.total === 'number' && m.left > m.total ? ', left above total' : ''
  const resets = 'resets' in m ? `, resets ${JSON.stringify(m.resets)}` : ''
  const extra = Object.keys(m).some((k) => !['left', 'total', 'offline', 'resets'].includes(k)) ? ', other members' : ''
  return `${name}: ${plain ? 'figures whole' : `left ${figures[0]}, total ${figures[1]}, offline ${figures[2]}`}${above}${resets}${extra}`
}

/** The forms a figure was written in, which only the text of a claim shows. */
function writtenForms(text: string): string {
  return `${/\d\.0[,}]/.test(text) ? ', written .0' : ''}${/\d[eE]\d/.test(text) ? ', written with an exponent' : ''}${text.includes('9007199254740993') ? ', written 2^53 + 1' : ''}${/-0[,}]/.test(text) ? ', written -0' : ''}`
}

/** A raw `met` claim: its container, and each member by what is wrong with it. */
function claimShape(value: unknown, text: string): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : 'a list of meters'
  if (typeof value !== 'object') return typeof value === 'string' ? 'a text' : typeof value === 'number' ? 'a number' : 'a flag'
  const members = Object.entries(value)
  if (members.length === 0) return 'an empty object'
  return `${members.length} members: ${members.map(([code, m]) => memberRule(code, m)).join(' + ')}${writtenForms(text)}`
}

/** `meterClaims`: the claim's shape (or that the lease has none). */
export const claimRule = (v: Vector): string => (v.json === null ? 'absent' : claimShape(JSON.parse(String(v.json)), String(v.json)))

/** A token's payload as written. */
const payloadText = (token: unknown): string => Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')

/** `meterLeases`: how the lease signs `met`, what else it says, and the verdict on it. */
export function leaseMetRule(v: Vector): string {
  const text = payloadText(v.token)
  let shape = 'not JSON'
  let tags = ''
  try {
    const payload = payloadOf(v.token)
    shape = 'met' in payload ? claimShape(payload.met, text) : 'no met'
    tags = ['test', 'grace', 'ent'].filter((claim) => (claim === 'ent' ? Object.keys(obj(payload.ent)).length > 0 : payload[claim] === true)).map((claim) => `, ${claim}`).join('')
  } catch {
    /* a payload that is not JSON has no shape */
  }
  const claims = obj(obj(v.verify).claims)
  const read = 'met' in claims ? `met read as ${Object.keys(obj(claims.met)).length} meters` : 'no met read'
  return `${shape}${tags}; ${read}: ${leaseVerdict(v)}`
}

/** The ways an amount can be given. */
function amountForm(v: Vector): string {
  if (!('n' in v)) return 'n absent'
  const n = v.n
  if (typeof n === 'string') return 'n a text'
  if (typeof n !== 'number') return 'n another type'
  if (!Number.isInteger(n)) return 'n a fraction'
  if (n === MAX_METER_USES) return 'n the bound'
  if (n === MAX_METER_USES + 1) return 'n one past the bound'
  return n < 0 ? 'n negative' : n === 0 ? 'n zero' : n === 1 ? 'n 1' : 'n a batch'
}

/** A code by its length in UTF-16 units and what it is made of. */
function codeForm(code: string): string {
  const astral = [...code].filter((c) => c.length === 2).length
  const kind = astral > 0 ? `${astral} astral` : /[^\x20-\x7e]/.test(code) ? 'beyond ASCII' : code.includes(' ') ? 'with a space' : code !== code.toLowerCase() ? 'capitals' : 'plain'
  return `code of ${code.length} units, ${kind}`
}

/** `useAmounts`: the amount and the code. */
export const askedRule = (v: Vector): string => `${amountForm(v)}; ${codeForm(String(v.meter))}`

/** A figure set, by its meters and what each says (for the vectors' inputs). */
const figureText = (f: unknown): string => {
  const m = obj(f)
  return `${String(m.left)}/${String(m.total)}/${String(m.offline)}${m.resets === true ? 'r' : ''}`
}

/** `meterFigures`: for each meter either names, where the figure came from and how far its time was from the lease's second. */
export function figuresRule(v: Vector): string {
  const iat = Number(v.iat)
  const met = obj(v.met)
  const stored = obj(v.figures)
  const codes = [...new Set([...Object.keys(met), ...Object.keys(stored)])]
  const parts = codes.map((code) => {
    const s = Object.hasOwn(stored, code) ? obj(stored[code]) : undefined
    const inLease = Object.hasOwn(met, code)
    const offset = s === undefined ? '' : `${Number(s.at) - iat * 1000 >= 0 ? '+' : ''}${Number(s.at) - iat * 1000}`
    if (s !== undefined && inLease) return `${code}: lease and stored (${offset} ms)${figureText(s) !== figureText(met[code]) ? ' differing' : ''}`
    return s !== undefined ? `${code}: stored only (${offset} ms)` : `${code}: lease only`
  })
  return parts.length > 0 ? parts.join('; ') : 'no meters'
}

/** The journal's entries for a meter, counted by kind. */
function kindsFor(spends: unknown, meter?: string): string {
  const entries = list(spends).map(obj).filter((e) => meter === undefined || e.meter === meter)
  const counts = ['offline', 'unanswered', 'void'].map((kind) => [kind, entries.filter((e) => e.kind === kind).length] as const)
  const shown = counts.filter(([, n]) => n > 0).map(([kind, n]) => `${kind} x${n}`)
  return shown.length > 0 ? shown.join(', ') : 'no entries'
}

/** `meterStatuses`: for each meter with a figure, what the journal holds of it, and what it did to `left`. */
export function statusRule(v: Vector): string {
  const figures = obj(v.figures)
  const spends = list(v.spends).map(obj)
  const codes = Object.keys(figures)
  if (codes.length === 0) return 'no figures'
  const parts = codes.map((code) => {
    const f = obj(figures[code])
    const unsynced = spends.filter((e) => e.meter === code && e.kind !== 'void').reduce((sum, e) => sum + Number(e.n), 0)
    const net = Number(f.left) - unsynced
    const effect = net < 0 ? 'floored' : net === 0 && unsynced > 0 ? 'exactly spent' : unsynced > 0 ? 'net' : 'as it is'
    return `${code}${f.resets === true ? ' (resets)' : ''}: ${kindsFor(spends, code)}, ${effect}`
  })
  const unshown = spends.filter((e) => !codes.includes(String(e.meter))).length
  return `${parts.join('; ')}${unshown > 0 ? `; ${unshown} entries for a meter with no figure` : ''}`
}

/** `offlineSpends`: the amount against the allowance, what is left and what the journal holds. */
export function offlineRule(v: Vector): string {
  const meter = String(v.meter)
  const figures = obj(v.figures)
  const spends = list(v.spends).map(obj)
  const outcome = obj(v.expect)
  const verdict = outcome.ok === true ? 'allowed' : String(outcome.error)
  const own = spends.filter((e) => e.meter === meter)
  const others = spends.length - own.length
  if (!Object.hasOwn(figures, meter)) return `${verdict}: no figure for ${meter === 'constructor' ? 'a name like a member of Object.prototype' : 'the meter'}`
  const f = obj(figures[meter])
  const limit = outcome.limit === undefined ? '' : `, limit ${String(outcome.limit)}`
  return `${verdict}: n ${String(v.n)}, allowance ${String(f.offline)}, left ${String(f.left)}${limit}, journal ${kindsFor(own)} (${own.filter((e) => e.kind !== 'void').reduce((s, e) => s + Number(e.n), 0)} unsynced)${others > 0 ? `, ${others} for other meters` : ''}`
}

/** How a stored wait stands against the device clock. */
function waitForm(state: Record<string, unknown>, clockNow: number): string {
  const since = state.backoffSince
  if (typeof since !== 'number') return 'no wait'
  const ms = state.backoffMs
  const label = ms === RETRY_UNANSWERED_MS ? 'a minute' : ms === ASK_AGAIN_MS ? 'an hour' : ms === undefined ? 'no length' : String(ms)
  const into = clockNow - since
  if (into < 0) return `a wait of ${label} set back`
  const left = typeof ms === 'number' ? ms - into : Number.NaN
  return `a wait of ${label}, ${Number.isNaN(left) ? 'unmeasured' : left > 0 ? `${left} ms left` : left === 0 ? 'ends now' : `over by ${-left} ms`}`
}

/** How the journal's own wait stands against the guarded clock. */
function journalForm(spends: unknown, now: number): string {
  const entries = list(spends).map(obj)
  if (spends === undefined) return 'no journal'
  if (entries.length === 0) return 'an empty journal'
  const waiting = entries.filter((e) => e.kind !== 'offline')
  if (waiting.length === 0) return `offline only x${entries.length}`
  // An entry opened after the guarded clock is left out of the wait, of its count and of its newest.
  const behind = waiting.filter((e) => Number(e.at) <= now)
  const offline = entries.length - waiting.length
  const kinds = ['unanswered', 'void'].map((kind) => [kind, waiting.filter((e) => e.kind === kind).length] as const).filter(([, n]) => n > 0)
  const mix = kinds.map(([kind, n]) => `${n} ${kind}`).join(' + ')
  const aheadBy = waiting.filter((e) => Number(e.at) > now).map((e) => Number(e.at) - now)
  const ahead = aheadBy.length > 0 ? `, ${aheadBy.length} opened ahead of the clock by ${Math.min(...aheadBy)} ms (left out)` : ''
  const head = `${mix}${offline > 0 ? ` and ${offline} offline` : ''}${ahead}`
  if (behind.length === 0) return `${head}, no wait to measure`
  const newest = Math.max(...behind.map((e) => Number(e.at)))
  const wait = Math.min(ASK_AGAIN_MS, RETRY_UNANSWERED_MS * 2 ** (behind.length - 1))
  const left = newest + wait - now
  const decider = new Set(behind.map((e) => e.kind)).size > 1 ? `, the ${String(behind.find((e) => Number(e.at) === newest)?.kind)} newest` : ''
  return `${head}${decider}, ${left > 0 ? `${left} ms left` : left === 0 ? 'ends now' : `over by ${-left} ms`}`
}

/**
 * How the wait of an uncovered spend stands: the voids ahead of the guarded clock, and those ahead of the device clock, are
 * left out; of the others the newest decides, and is named by its age.
 */
function voidForm(spends: unknown, now: number, clockNow: number): string {
  const voids = list(spends).map(obj).filter((e) => e.kind === 'void')
  const aheadOfGuard = voids.filter((e) => Number(e.at) > now).length
  const counted = voids.filter((e) => Number(e.at) <= now && Number(e.at) <= clockNow)
  const aheadOfDevice = voids.length - aheadOfGuard - counted.length
  const ahead = `${aheadOfGuard > 0 ? `${aheadOfGuard} void(s) ahead of the guarded clock (left out), ` : ''}${aheadOfDevice > 0 ? `${aheadOfDevice} void(s) ahead of the device clock (left out), ` : ''}`
  if (counted.length === 0) return `${ahead}no void wait`
  const age = now - Math.max(...counted.map((e) => Number(e.at)))
  const left = RETRY_UNANSWERED_MS - age
  return `${ahead}a void wait ${left > 0 ? `${left} ms left` : left === 0 ? 'ends now' : `over by ${-left} ms`}, decided by the void ${age} ms old`
}

/** `useAsks`: the stored wait, the journal's, the two clocks, and the answer. */
export function asksRule(v: Vector): string {
  const state = obj(v.state)
  const apart = v.clockNow !== v.now ? `, the device clock ${Number(v.clockNow) - Number(v.now)} ms from the guarded` : ''
  const entries = list(state.spends).map(obj)
  const order = entries.length === 2 && Number(entries[0]?.at) > Number(entries[1]?.at) ? ', the newest first' : ''
  const refused = v.covered === false ? `; the allowance refuses, ${voidForm(state.spends, Number(v.now), Number(v.clockNow))}` : ''
  return `${waitForm(state, Number(v.clockNow))}; ${journalForm(state.spends, Number(v.now))}${apart}${order}${refused} -> ${String(v.expect)}`
}

/** `syncAsks`: the lease, the wait and the journal, and the answer. */
export function syncRule(v: Vector): string {
  const claims = obj(v.claims)
  const lease = `${Number(claims.major) >= 1_000_000 ? 'open' : 'bounded'}, ${(Number(claims.exp) - Number(v.now) / 1000) / 86_400 < 7 ? 'near its end' : 'far from its end'}`
  const state = obj(v.state)
  return `${lease}; ${waitForm(state, Number(v.clockNow))}; ${journalForm(state.spends, Number(v.now))}${v.clockNow !== v.now ? ', clocks apart' : ''}; heard ${String(state.checkedMajor)} -> ${String(v.expect)}`
}

/** What an `at` is: a whole time, or what else. */
function atForm(at: unknown): string {
  if (typeof at !== 'number') return 'a text'
  return Number.isInteger(at) ? (at < 0 ? 'negative' : 'whole') : 'a fraction'
}

/** What an answer's `meters` is, by the names it holds. */
function metersForm(meters: unknown): string {
  if (typeof meters !== 'object' || meters === null || Array.isArray(meters)) return typeof meters
  return `{${Object.keys(meters).join(',')}}`
}

/** An answer to a request, by its status and the members of its body. */
export function responseForm(response: unknown): string {
  if (response === null) return 'no answer'
  const r = obj(response)
  const json = r.json
  const bits = [String(r.status)]
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    bits.push(`body ${json === null ? 'null' : Array.isArray(json) ? 'a list' : typeof json}`)
    return bits.join(' ')
  }
  const b = obj(json)
  if ('error' in b) bits.push(`error ${String(b.error)}`)
  if ('spent' in b) bits.push(`spent ${JSON.stringify(b.spent)}`)
  if ('left' in b) bits.push(`left ${JSON.stringify(b.left)}`)
  if ('at' in b) bits.push(`at ${atForm(b.at)}`)
  if ('meters' in b) bits.push(`meters ${metersForm(b.meters)}`)
  if ('spends' in b) bits.push(`spends x${list(b.spends).length}`)
  if (bits.length === 1) bits.push('empty body')
  return bits.join(', ')
}

/** `useOutcomes`: the answer, the device, and what it did. */
export function outcomeRule(v: Vector): string {
  const device = obj(v.device)
  const kind = typeof device.kind === 'string' ? device.kind : 'no kind'
  const e = obj(v.expect)
  const patch = obj(e.patch)
  const saved = Object.keys(patch).length === 0 ? 'saves nothing' : `saves ${Object.keys(patch).sort().join('+')}`
  const figures = Object.keys(obj(e.figures)).length
  const confirmed = list(e.confirmed).map((c) => ('void' in obj(c) ? 'void' : 'count')).join('+') || 'none'
  return `${responseForm(v.response)}; device ${kind}${typeof device.ownClaim === 'string' ? ' with a claim' : ''} -> ${String(e.outcome)}${e.refusal !== undefined ? ` ${String(e.refusal)}` : ''}${e.left !== undefined ? ` left ${String(e.left)}` : ''}, ${saved}, ${figures} figures, confirmed ${confirmed}`
}

/** The entries of a journal, as a short list of kinds and counts. */
function entriesForm(spends: unknown, now: number): string {
  if (spends === undefined) return 'no journal'
  const entries = list(spends).map(obj)
  const old = entries.filter((e) => now - Number(e.at) > PENDING_MAX_MS).length
  const edge = entries.filter((e) => now - Number(e.at) === PENDING_MAX_MS).length
  return `${entries.length} (${kindsFor(entries)})${old > 0 ? `, ${old} past the horizon` : ''}${edge > 0 ? `, ${edge} exactly at it` : ''}`
}

/** What an op is, by its fields and how they meet the journal. */
function opForm(v: Vector): string {
  const op = obj(v.op)
  const latest = obj(v.latest)
  const held = list(latest.spends).map(obj)
  const kind = String(op.kind)
  if (kind === 'offline' || kind === 'unanswered' || kind === 'void') {
    const idHeld = held.find((e) => e.id === op.id)
    const open = held.some((e) => e.kind === 'offline' && e.meter === op.meter)
    const limit = op.limit === undefined ? '' : `, limit ${String(op.limit)}`
    const told = op.told === true ? ', told' : ''
    return `${kind} n ${String(op.n)}${limit}${told}${idHeld ? `, its id held by ${String(idHeld.kind)}` : ''}${kind === 'offline' && open ? ', an offline entry of its meter open' : ''}`
  }
  if (kind === 'confirmed') {
    const named = list(op.entries).map(obj).map((c) => {
      const entry = held.find((e) => e.id === c.id)
      return `${entry ? `${String(entry.kind)} ${String(entry.n)}` : 'not held'} by ${c.void === true ? 'a void' : `${String(c.n)}`}`
    })
    return `confirmed ${named.length === 0 ? 'nothing' : named.join(', ')}`
  }
  if (kind === 'figures') {
    const stored = obj(latest.meterFigures)
    const parts = Object.entries(obj(op.figures)).map(([code, f]) => {
      const was = Object.hasOwn(stored, code) ? Number(obj(stored[code]).at) : undefined
      const at = Number(obj(f).at)
      return `${code} ${was === undefined ? 'new' : at > was ? 'newer' : at < was ? 'older' : 'tied'}`
    })
    return `figures ${parts.join(', ')}`
  }
  return kind
}

/** `journals`: the op against the journal before, the activation it is about, and the journal after. */
export function journalRule(v: Vector): string {
  const latest = obj(v.latest)
  const op = obj(v.op)
  const e = obj(v.expect)
  const now = Number(v.now)
  const about = latest.activationId === undefined ? 'no activation' : op.about === undefined || op.about === latest.activationId ? 'the activation' : 'another activation'
  const figuresBefore = Object.keys(obj(latest.meterFigures)).length
  const figuresAfter = Object.keys(obj(e.meterFigures)).length
  return `${opForm(v)}; ${about}; before ${entriesForm(latest.spends, now)}, ${figuresBefore} figures; after ${entriesForm(e.spends, now)}, ${figuresAfter} figures${e.refused === true ? '; refused' : ''}`
}

/** `spendReports`: the journal in and the report out. */
export function reportRule(v: Vector): string {
  const spends = list(v.spends).map(obj)
  const out = list(v.expect).map(obj)
  const runs = spends.map((e) => String(e.kind)).filter((kind, i, all) => kind !== all[i - 1]).join(',')
  const ns = spends.length <= 3 ? `, n ${spends.map((e) => String(e.n)).join('+')}` : ''
  const meters = new Set(spends.map((e) => e.meter)).size
  return `${spends.length} in (${runs || 'none'}${ns}, ${meters} meters), ${out.length} out${out.some((e) => e.void === true) ? ', a void marked' : ''}`
}

/** What one member of a list of confirmations is. */
function confirmationForm(member: unknown): string {
  if (typeof member !== 'object' || member === null || Array.isArray(member)) return member === null ? 'null' : Array.isArray(member) ? 'a list' : typeof member
  const m = obj(member)
  const id = m.id === undefined ? 'no id' : typeof m.id !== 'string' ? 'id not text' : m.id === '' ? 'empty id' : 'id'
  const voided = 'void' in m ? `void ${JSON.stringify(m.void)}` : ''
  const count = 'n' in m ? `n ${figureForm(m.n)}` : ''
  const extra = Object.keys(m).some((k) => !['id', 'n', 'void'].includes(k)) ? 'other members' : ''
  return [id, voided, count, extra].filter((part) => part !== '').join(' ')
}

/** `spendConfirmations`: the answer, the members it names, and what was read of them. */
export function confirmationRule(v: Vector): string {
  const response = obj(v.response)
  const json = response.json
  const spends = obj(json).spends
  const members = Array.isArray(spends) ? `[${spends.map(confirmationForm).join('; ')}]` : spends === undefined ? 'names none' : `spends ${Array.isArray(spends) ? 'a list' : typeof spends}`
  const same = list(spends).map(obj).filter((m) => m.id !== undefined).map((m) => m.id)
  const twice = same.length !== new Set(same).size ? ', an id twice' : ''
  if (v.response === null) return 'no answer'
  return `${response.status}; ${typeof json === 'object' && json !== null && !Array.isArray(json) ? members : `body ${json === null ? 'null' : Array.isArray(json) ? 'a list' : typeof json}`}${twice} -> ${list(v.expect).length} read`
}
