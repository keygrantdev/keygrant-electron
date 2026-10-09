/**
 * Buying from the app with no key typed (pickup.ts), and the launch report
 * (trials.ts): the link `purchaseUrl` answers for a held secret
 * (`purchaseUrls`), how long a secret is held (`purchaseTokenKept`), when
 * `status()` asks the claim (`claimDue`), a claim's answer read
 * (`parseClaimBody`) and what it saves and says (`claimOutcomes`), when a
 * running trial reports its launch (`trialReportDue`), the reference a link
 * carries for a secret (`purchaseReferences`), and what a claim sends
 * (`claimBodies`).
 */
import { OPEN_MAJOR, type LeaseClaims } from '@keygrant/shared'
import { CLAIM_EAGER_MS, CLAIM_WAIT_MS, PURCHASE_TOKEN_MS, TRIAL_REPORT_MS, type LeaseCheck } from '../../src/offline.js'
import type { DeviceKind } from '../../src/types.js'
import type { ClaimVector, GroupInputs } from '../inputs.js'
import { DAY, DAY_MS, HOUR_MS, KEY, NOW, NOW_S, claims } from './common.js'

/** A purchase secret as `purchaseUrl` makes one: the base64url of 32 bytes, 43 characters. */
export const TOKEN = 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c'
const LINK = 'https://buy.stripe.com/test_abc'

export function purchaseUrls(): GroupInputs['purchaseUrls'][] {
  const secret = TOKEN
  return [
    { name: 'no query: the reference added', link: LINK, secret },
    { name: 'parameters: kept as written and in order, the reference last', link: `${LINK}?prefilled_email=jo%40example.com&locale=fr`, secret },
    { name: 'a client_reference_id already there: replaced', link: `${LINK}?client_reference_id=act_1&locale=fr`, secret },
    { name: 'two client_reference_ids: one reference in their place', link: `${LINK}?client_reference_id=a&x=1&client_reference_id=b`, secret },
    { name: 'a client_reference_id with no value: replaced', link: `${LINK}?client_reference_id&x=1`, secret },
    { name: 'a name that only starts with client_reference_id: kept', link: `${LINK}?client_reference_id_old=1`, secret },
    { name: 'a fragment: kept, after the query', link: `${LINK}#checkout`, secret },
    { name: 'parameters and a fragment', link: `${LINK}?locale=fr#checkout`, secret },
    { name: 'empty parameters: left out', link: `${LINK}?&locale=fr&&`, secret },
    { name: 'an empty query: the reference alone', link: `${LINK}?`, secret },
    { name: 'a value with = in it: kept as written', link: `${LINK}?redirect=a=b`, secret },
    { name: 'another host, a port and a deeper path: kept', link: 'https://pay.example.com:8443/buy/sluice?plan=pro', secret },
  ]
}

/** The reference a link carries for a secret (`purchaseReference`): `kgp_` and the base64url of its SHA-256. */
export function purchaseReferences(): GroupInputs['purchaseReferences'][] {
  const bytes = (fill: (i: number) => number) => Buffer.from(Array.from({ length: 32 }, (_, i) => fill(i))).toString('base64url')
  return [
    { name: 'a secret of letters and digits', secret: TOKEN },
    { name: 'a secret of 32 zero bytes', secret: bytes(() => 0) },
    { name: 'a secret of the bytes 0 to 31', secret: bytes((i) => i) },
    { name: 'a secret with - and _ in it', secret: bytes((i) => (i % 2 === 0 ? 0xfb : 0xff)) },
  ]
}

export function purchaseTokenKept(): GroupInputs['purchaseTokenKept'][] {
  const at = (purchaseTokenAt: number) => ({ purchaseToken: TOKEN, purchaseTokenAt })
  return [
    { name: 'no token: not held', state: {}, now: NOW },
    { name: 'handed out now: held', state: at(NOW), now: NOW },
    { name: 'a day inside its bound: held', state: at(NOW - PURCHASE_TOKEN_MS + DAY_MS), now: NOW },
    { name: 'a millisecond inside its bound: held', state: at(NOW - PURCHASE_TOKEN_MS + 1), now: NOW },
    { name: 'exactly its bound: dropped', state: at(NOW - PURCHASE_TOKEN_MS), now: NOW },
    { name: 'a day past its bound: dropped', state: at(NOW - PURCHASE_TOKEN_MS - DAY_MS), now: NOW },
    { name: 'stamped ahead of now: held', state: at(NOW + DAY_MS), now: NOW },
    { name: 'a token with no stamp: dropped', state: { purchaseToken: TOKEN }, now: NOW },
    { name: 'a stamp with no token: not held', state: { purchaseTokenAt: NOW }, now: NOW },
  ]
}

export function claimDue(): GroupInputs['claimDue'][] {
  // A link handed out an hour ago (fresh), asked at `claimAskedAt` (device clock).
  const asked = (claimAskedAt: number) => ({ purchaseToken: TOKEN, purchaseTokenAt: NOW - HOUR_MS, claimAskedAt })
  const linked = (purchaseTokenAt: number) => ({ purchaseToken: TOKEN, purchaseTokenAt })
  const now = NOW
  return [
    { name: 'not asked since the link: due', state: linked(NOW), clockNow: NOW, now },
    { name: 'asked this moment: not yet', state: asked(NOW), clockNow: NOW, now },
    { name: 'a millisecond inside the wait: not yet', state: asked(NOW - CLAIM_WAIT_MS + 1), clockNow: NOW, now },
    { name: 'exactly the wait: due', state: asked(NOW - CLAIM_WAIT_MS), clockNow: NOW, now },
    { name: 'twenty minutes after: due', state: asked(NOW - 20 * 60_000), clockNow: NOW, now },
    { name: 'the device clock set back before the ask: due', state: asked(NOW + 1000), clockNow: NOW, now },
    { name: 'a link a millisecond under a day old: due', state: linked(NOW - CLAIM_EAGER_MS + 1), clockNow: NOW, now },
    { name: 'a link exactly a day old: only refresh() and startTrial() ask', state: linked(NOW - CLAIM_EAGER_MS), clockNow: NOW, now },
    { name: 'a link ten days old, the wait long over: not due', state: { ...linked(NOW - 10 * DAY_MS), claimAskedAt: NOW - DAY_MS }, clockNow: NOW, now },
    { name: 'a link stamped ahead of the guarded clock: due', state: linked(NOW + 1000), clockNow: NOW, now },
    { name: 'a secret with no stamp: not due', state: { purchaseToken: TOKEN }, clockNow: NOW, now },
    {
      name: 'the guarded clock a day ahead of the device clock: freshness by the one, the wait by the other',
      state: { purchaseToken: TOKEN, purchaseTokenAt: NOW + DAY_MS - HOUR_MS, claimAskedAt: NOW - CLAIM_WAIT_MS },
      clockNow: NOW,
      now: NOW + DAY_MS,
    },
    {
      name: 'the guarded clock a day ahead: the wait still runs by the device clock, not due',
      state: { purchaseToken: TOKEN, purchaseTokenAt: NOW + DAY_MS - HOUR_MS, claimAskedAt: NOW - 1000 },
      clockNow: NOW,
      now: NOW + DAY_MS,
    },
    {
      name: 'the guarded clock a day ahead: the link is stale by it, though fresh by the device clock, not due',
      state: { purchaseToken: TOKEN, purchaseTokenAt: NOW - HOUR_MS },
      clockNow: NOW,
      now: NOW + DAY_MS,
    },
  ]
}

export function parseClaimBody(): GroupInputs['parseClaimBody'][] {
  const lease = 'header.payload.sig'
  return [
    { key: KEY, activationId: 'act_9', lease, inGrace: false, validUntil: null, future: { nested: [1] } },
    { key: KEY, lease },
    { pending: true },
    { pending: 'yes' },
    { pending: false },
    { error: 'spent' },
    { error: '' },
    { error: 42 },
    { key: 7, activationId: ['act'], lease: null },
    {},
    null,
    'a string',
    [],
    42,
  ].map((body) => ({ body }))
}

/** A row of the claim table: the answer, the check of the lease a full 200 carried, the build's major. */
interface ClaimRow {
  name: string
  response: ClaimVector['response']
  check?: LeaseCheck
  major?: number
  /** Also for a fingerprint of each kind (only a bought key saves what it hashes). */
  everyKind?: boolean
}

/** A lease's check that licenses this build, with its claims. */
function licenses(over: Record<string, unknown> = {}, test = false): LeaseCheck {
  return { ok: true, test, claims: claims(over) as LeaseClaims }
}

const FULL = { key: KEY, activationId: 'act_1', lease: 'header.payload.signature' }

export function claimOutcomes(): ClaimVector[] {
  const kinds: [string, DeviceKind | null][] = [['a machine id', 'machine'], ['the host name', 'hostname'], ['a fingerprint of no kind', null]]
  const rows = [...boughtRows(), ...keptRows(), ...droppedRows()]
  return rows.flatMap((row) =>
    (row.everyKind ? kinds : kinds.slice(0, 1)).map(([who, kind]) => ({
      name: row.everyKind ? `${row.name}; claimed under ${who}` : row.name,
      response: row.response,
      check: row.check ?? null,
      clockNow: NOW - 30_000,
      now: NOW,
      major: row.major ?? 3,
      kind,
    })),
  )
}

/** A full 200 whose lease licenses this build: saved as an activation, licensed. */
function boughtRows(): ClaimRow[] {
  const ok = { status: 200, json: { ...FULL, inGrace: false, validUntil: null } }
  return [
    { name: 'a 200 with the key, its activation and a lease that licenses: bought', response: ok, check: licenses(), everyKind: true },
    { name: 'a 200 bought, a test licence', response: ok, check: licenses({ test: true }, true) },
    { name: 'a 200 bought, granting entitlements', response: ok, check: licenses({ ent: { edition: 'pro', seats: 5 } }) },
    {
      name: 'a 200 bought, inside an open upgrade window: the kept major is the build',
      response: ok,
      check: licenses({ major: OPEN_MAJOR, upgradeUntil: NOW_S + 30 * DAY }),
      major: 5,
    },
    { name: 'a 200 bought that also says pending: bought', response: { status: 200, json: { ...FULL, pending: true } }, check: licenses() },
    { name: 'a 200 bought that also carries an error word: bought', response: { status: 200, json: { ...FULL, error: 'spent' } }, check: licenses() },
  ]
}

/** "Not bought yet", no answer, and every answer with no error word: the token kept, the wait started. */
function keptRows(): ClaimRow[] {
  return [
    { name: 'a 200 pending: not bought yet, kept', response: { status: 200, json: { pending: true } } },
    { name: 'no answer at all: kept', response: null },
    { name: 'a 500: kept', response: { status: 500, json: { error: 'internal' } } },
    { name: 'a 503 with no body: kept', response: { status: 503, json: null } },
    { name: 'a 502 that says spent: still no answer, kept', response: { status: 502, json: { error: 'spent' } } },
    { name: 'a 429: kept', response: { status: 429, json: { error: 'rate-limited' } } },
    { name: 'a 404 page, not JSON (a server with no claim endpoint): kept', response: { status: 404, json: '<html>Not Found</html>' } },
    { name: 'a 404 with no error word: kept', response: { status: 404, json: { message: 'Not Found' } } },
    { name: 'a 200 page, not JSON (a captive portal): kept', response: { status: 200, json: '<html>Sign in</html>' } },
    { name: 'a 200 with a key and a lease but no activation: kept', response: { status: 200, json: { key: KEY, lease: FULL.lease } } },
    { name: 'a 200 with nothing: kept', response: { status: 200, json: {} } },
    { name: 'a 200 whose pending is not true: kept', response: { status: 200, json: { pending: 'yes' } } },
    { name: 'a 403 whose error is empty: no word, kept', response: { status: 403, json: { error: '' } } },
  ]
}

/** An error word, and a full 200 whose lease does not license this build: the token dropped. */
function droppedRows(): ClaimRow[] {
  const ok = { status: 200, json: FULL }
  const word = (status: number, error: string) => ({ status, json: { error } })
  return [
    { name: 'a 409 spent: another device took it, dropped', response: word(409, 'spent') },
    { name: 'a 403 pickup-off: dropped, the key typed from the email', response: word(403, 'pickup-off') },
    { name: 'a 403 limit: an activation refusal, dropped', response: word(403, 'limit') },
    { name: 'a 403 revoked: dropped', response: word(403, 'revoked') },
    { name: 'a 400 invalid-request: dropped', response: word(400, 'invalid-request') },
    { name: 'a 404 unknown-product: dropped', response: word(404, 'unknown-product') },
    { name: 'a 200 with an error word and no key: dropped', response: word(200, 'spent') },
    { name: 'a 200 with the key, its lease expired here: dropped', response: ok, check: { ok: false, reason: 'expired' } },
    { name: "a 200 with the key, its lease not this licence's: dropped", response: ok, check: { ok: false, reason: 'tampered' } },
    { name: 'a 200 with the key, its lease for a newer build: dropped', response: ok, check: { ok: false, reason: 'upgrade' } },
    { name: 'a 200 with the key, its lease for an older build: dropped', response: ok, check: { ok: false, reason: 'outdated' } },
    { name: 'a 200 with the key, its lease for another device: dropped', response: ok, check: { ok: false, reason: 'device' } },
  ]
}

export function trialReportDue(): GroupInputs['trialReportDue'][] {
  const now = NOW
  return [
    { name: 'neither stamped: due', state: {}, now },
    { name: 'reported a day ago: due', state: { trialReportedAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'reported a millisecond under a day ago: not due', state: { trialReportedAt: NOW - TRIAL_REPORT_MS + 1 }, now },
    { name: 'a trial answer a day ago: due', state: { trialAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'a trial answer a millisecond under a day ago: not due', state: { trialAt: NOW - TRIAL_REPORT_MS + 1 }, now },
    { name: 'an old trial answer, a recent report: not due', state: { trialAt: NOW - 3 * DAY_MS, trialReportedAt: NOW - 1000 }, now },
    { name: 'a recent trial answer, an old report: not due', state: { trialAt: NOW - 1000, trialReportedAt: NOW - 3 * DAY_MS }, now },
    { name: 'both a day or more ago: due', state: { trialAt: NOW - 2 * DAY_MS, trialReportedAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'a report stamped ahead of now: not due', state: { trialReportedAt: NOW + 1000 }, now },
    { name: 'a trial answer stamped ahead of now: not due', state: { trialAt: NOW + 1000 }, now },
  ]
}

/** What a claim sends (`claimRequest`): its fingerprint, every fingerprint read within the server's bounds, and when none is sent. */
export function claimBodies(): GroupInputs['claimBodies'][] {
  const own = 'fingerprint-machine-own'
  const host = 'fingerprint-hostname-alt'
  const machine = { fingerprint: own, kind: 'machine' as const, alternates: [host] }
  const fallback = { fingerprint: null, kind: null, alternates: [host] }
  const base = { secret: TOKEN, deviceHold: true, deviceName: 'Rae’s laptop', major: 3, start: false }
  return [
    { name: 'a machine id and the host name: both, own first', ...base, identity: machine },
    { name: 'not held: every fingerprint read all the same, no kind', ...base, identity: machine, deviceHold: false },
    { name: 'a fingerprint of no kind, nothing else', ...base, identity: { fingerprint: own, kind: null, alternates: [] } },
    { name: 'the host name read as the fingerprint', ...base, identity: { fingerprint: host, kind: 'hostname', alternates: [] } },
    { name: 'from status(), the machine id not read: nothing sent', ...base, identity: fallback },
    { name: 'from startTrial(), the machine id not read: the host name', ...base, identity: fallback, start: true },
    { name: 'from startTrial(), not held, the machine id not read: the host name', ...base, identity: fallback, start: true, deviceHold: false },
    { name: 'from startTrial(), no fingerprint at all: nothing sent', ...base, identity: { fingerprint: null, kind: null, alternates: [] }, start: true },
    {
      name: 'six fingerprints read: the first four sent',
      ...base,
      identity: { fingerprint: own, kind: 'machine', alternates: [host, 'fp-a2', 'fp-a3', 'fp-a4', 'fp-a5'] },
    },
    {
      name: 'one of 201 characters and an empty one left out, one of 200 kept',
      ...base,
      identity: { fingerprint: own, kind: 'machine', alternates: ['x'.repeat(201), '', 'y'.repeat(200)] },
    },
    {
      name: 'its own fingerprint over 200 characters: sent as the fingerprint, left out of the list',
      ...base,
      identity: { fingerprint: 'z'.repeat(250), kind: 'machine', alternates: [host] },
    },
    {
      name: 'characters counted in UTF-16 units: 150 emoji are 300, left out; 100 are 200, kept',
      ...base,
      identity: { fingerprint: own, kind: 'machine', alternates: ['\u{1F600}'.repeat(150), '\u{1F600}'.repeat(100)] },
    },
    { name: 'no device name: none sent', ...base, identity: machine, deviceName: null, start: true },
    { name: 'an empty fingerprint left out', ...base, identity: { fingerprint: own, kind: 'machine', alternates: ['', host] } },
  ]
}
