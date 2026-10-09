/**
 * The `renewals` group: what a validate's answer saves and says (renewal.ts
 * `renewalOutcome`), row by row of the engine's answer table, each for a
 * device that read a machine id (whose kind every patch then carries,
 * `keyedBy`), one that read the host name, one whose fingerprint is of no kind
 * (a custom `get()`), and, where it bears on the answer, a run that could not
 * tell.
 */
import { OPEN_MAJOR, fingerprintClaim, type LeaseClaims } from '@keygrant/shared'
import type { LeaseCheck } from '../../src/offline.js'
import type { DeviceView, RenewalVector } from '../inputs.js'
import { DAY, KEY, NOW, NOW_S, claims, type Context } from './common.js'

/** A row of the table: the answer, and the check of the lease a 200 carried (none by default). */
interface Row {
  name: string
  response: RenewalVector['response']
  check?: LeaseCheck
  major?: number
  keptMajor?: number | null
  /** Also for a run that could not tell who the device is. */
  cannotTell?: boolean
}

/** The lease a 200 carries: any token; its check is given (`check`), not made. */
const LEASE = 'header.payload.signature'
const MAJOR = 3

export async function renewals(ctx: Context): Promise<RenewalVector[]> {
  const devices: [string, DeviceView][] = [
    ['a machine id', { kind: 'machine', ownClaim: ctx.ownClaim }],
    ['the host name', { kind: 'hostname', ownClaim: ctx.altClaim }],
    ['a fingerprint of no kind', { kind: null, ownClaim: await fingerprintClaim('licence-dongle-4471') }],
  ]
  const cannotTell: [string, DeviceView] = ['a run that cannot tell', { kind: null, ownClaim: null }]
  const rows = [...unanswered(), ...leases(), ...unusable(), ...refusals(), ...others(), ...entitled(), ...unknownKey()]
  return rows.flatMap((row) =>
    [...devices, ...(row.cannotTell ? [cannotTell] : [])].map(([who, device]) => ({
      name: `${row.name}; read on ${who}`,
      response: row.response,
      check: row.check ?? null,
      askedAt: NOW - 30_000,
      now: NOW,
      major: row.major ?? MAJOR,
      key: KEY,
      keptMajor: row.keptMajor === undefined ? 2 : row.keptMajor,
      device,
    })),
  )
}

/** A lease's check that licenses this build, with its claims (`keptWith` reads `upgradeUntil`). */
function licenses(over: Record<string, unknown> = {}, test = false): LeaseCheck {
  return { ok: true, test, claims: claims(over) as LeaseClaims }
}

/** No answer at all, a 5xx and a 429: no verdict, whatever the body says. */
function unanswered(): Row[] {
  return [
    { name: 'no answer at all (it threw or timed out): wait a minute', response: null, cannotTell: true },
    { name: 'a 500: wait an hour', response: { status: 500, json: { error: 'internal' } } },
    { name: 'a 503 with no body: wait an hour', response: { status: 503, json: null } },
    { name: 'a 502 that says revoked: still no answer', response: { status: 502, json: { error: 'revoked' } } },
    { name: 'a 429: wait an hour', response: { status: 429, json: { error: 'rate-limited' } } },
    { name: 'a 429 that says revoked: still no answer', response: { status: 429, json: { error: 'revoked' } } },
  ]
}

/** A 200 whose lease the server stands behind: licensed, or invalid for this build or device, and kept. */
function leases(): Row[] {
  const ok = { status: 200, json: { lease: LEASE } }
  return [
    { name: 'a 200 with a lease that licenses this build', response: ok, check: licenses(), cannotTell: true },
    { name: 'a 200 with a test lease', response: ok, check: licenses({ test: true }, true) },
    {
      name: 'a 200 with a lease in an open upgrade window: the kept major raised to the build',
      response: ok,
      check: licenses({ major: OPEN_MAJOR, upgradeUntil: NOW_S + 30 * DAY }),
      major: 5,
    },
    {
      name: 'a 200 with a lease whose window has closed: the kept major as it was',
      response: ok,
      check: licenses({ major: OPEN_MAJOR, upgradeUntil: NOW_S - DAY }),
      major: 5,
    },
    { name: 'a 200 with a lease, nothing kept and no window: the kept major cleared', response: ok, check: licenses(), keptMajor: null },
    { name: 'a 200 with a lease for a newer build than it covers: kept, upgrade', response: ok, check: { ok: false, reason: 'upgrade' } },
    { name: 'a 200 with a lease for an older build than it covers: kept, outdated', response: ok, check: { ok: false, reason: 'outdated' } },
    { name: 'a 200 with a lease for another device: kept, device', response: ok, check: { ok: false, reason: 'device' }, cannotTell: true },
  ]
}

/** A 200 with no lease the SDK can use: no verdict, and never a lockout on a bad body. */
function unusable(): Row[] {
  const ok = { status: 200, json: { lease: LEASE } }
  return [
    { name: 'a 200 with an expired lease: no verdict', response: ok, check: { ok: false, reason: 'expired' } },
    { name: "a 200 with a lease not this licence's: no verdict", response: ok, check: { ok: false, reason: 'tampered' } },
    { name: 'a 200 with no lease: no verdict', response: { status: 200, json: {} } },
    { name: 'a 200 whose lease is not a string: no verdict', response: { status: 200, json: { lease: 42 } } },
    { name: 'a 200 whose lease is empty: no verdict', response: { status: 200, json: { lease: '' } } },
    { name: 'a 200 that says revoked: not a verdict', response: { status: 200, json: { error: 'revoked' } } },
    { name: 'a 200 whose body is not an object: no verdict', response: { status: 200, json: LEASE } },
    { name: 'a 200 with no body: no verdict', response: { status: 200, json: null } },
  ]
}

/** The server's refusals (`refusalOf`): the verdict, saved as `refusalPatch` makes it. */
function refusals(): Row[] {
  const refused = (error: string) => ({ status: 403, json: { error } })
  return [
    { name: 'a 403 revoked: the lease dropped', response: refused('revoked') },
    { name: 'a 403 expired: revoked, the lease dropped', response: refused('expired') },
    { name: 'a 403 deactivated: revoked, the lease dropped', response: refused('deactivated') },
    { name: 'a 403 device: refused for this device', response: refused('device'), cannotTell: true },
    { name: 'a 403 upgrade-required: refused for this build and newer', response: refused('upgrade-required') },
    { name: 'a 403 update-required: refused for this build and older', response: refused('update-required') },
    // The word decides, not the status: every refusal the server makes is a 403.
    { name: 'a 401 that says expired: still a verdict', response: { status: 401, json: { error: 'expired' } } },
  ]
}

/** A 200 whose lease grants entitlements: the licensed status carries them (offline.ts `leaseStatus`). */
function entitled(): Row[] {
  const ok = { status: 200, json: { lease: LEASE } }
  const ent = { edition: 'pro', seats: 5, beta: false }
  return [
    { name: 'a 200 with a lease granting entitlements: licensed, with them', response: ok, check: licenses({ ent }) },
    { name: 'a 200 with a test lease granting entitlements: licensed, test, with them', response: ok, check: licenses({ ent, test: true }, true) },
  ]
}

/** Any other answer: not a verdict. */
function others(): Row[] {
  return [
    { name: 'a 404 unknown-product: no verdict', response: { status: 404, json: { error: 'unknown-product' } } },
    { name: 'a 400 invalid-request: no verdict', response: { status: 400, json: { error: 'invalid-request' } } },
    { name: 'a 409 limit: no verdict', response: { status: 409, json: { error: 'limit' } } },
    { name: 'a 403 with no error word: no verdict', response: { status: 403, json: { message: 'Forbidden' } } },
    { name: 'a 403 whose body is the word revoked, not an object: no verdict', response: { status: 403, json: 'revoked' } },
    { name: 'a 403 whose body is a list: no verdict', response: { status: 403, json: ['revoked'] } },
    { name: 'a 403 with no body: no verdict', response: { status: 403, json: null } },
  ]
}

/** A 200 whose lease is signed by a key the build does not carry: no usable lease, no verdict (the lease held stands). */
function unknownKey(): Row[] {
  const ok = { status: 200, json: { lease: LEASE } }
  return [{ name: 'a 200 with a lease signed by a key the build does not carry: no verdict', response: ok, check: { ok: false, reason: 'unknown-key' } }]
}
