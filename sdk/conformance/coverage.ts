/**
 * What each group of `conformance/vectors.json` must cover: every outcome its
 * decision gives (for the hash groups, every kind of input), so that deleting
 * the one vector that shows one (the only test licence, the only expired lease
 * that keeps its claims, an error word, one platform's machine id) fails the
 * reference's suite (`src/conformance.test.ts`) instead of quietly leaving the
 * ports unpinned.
 *
 * A group has one or more facets; each maps a vector to the outcome it shows,
 * and the set of outcomes over the group must be exactly the one listed.
 */
import type { FirstGroup, GroupName } from './inputs.js'
import { LATER_COVERAGE } from './coverage-later.js'
import { KEY_COVERAGE } from './coverage-keys.js'
import { FILE_COVERAGE } from './coverage-files.js'
import { USER_LOCK_COVERAGE } from './coverage-user-lock.js'
import { METER_COVERAGE } from './coverage-meters.js'
import { PICKUP_COVERAGE } from './coverage-pickup.js'
import {
  answer,
  endSecond,
  entSigned,
  entitlementSpecials,
  heldTo,
  judgedBy,
  keyNamed,
  leaseVerdict,
  mergeBasis,
  mergeOutcome,
  numberForm,
  numberRange,
  obj,
  payloadOf,
  renewalFacets,
  script,
  signedToStatus,
  statusShape,
  trimOutcome,
  type Facet,
} from './facets.js'
import { MISREAD } from './vectors/numbers.js'

export type { Facet } from './facets.js'

/**
 * Every kind of `ent` a licence lease signs, and the status it gives with no
 * verdict (`leaseStatus`): none read from anything but an object or from
 * members all malformed, the good members of a partly malformed one, and none
 * on a status that does not license, though the lease grants them.
 */
const LEASE_STATUSES = [
  'a flag -> licensed',
  'a list -> licensed',
  'a number -> licensed',
  'a text -> licensed',
  'absent -> licensed',
  'all malformed -> licensed',
  'empty -> licensed',
  'empty -> licensed, test',
  'flat -> expired: offline',
  'flat -> invalid: device',
  'flat -> invalid: outdated',
  'flat -> invalid: tampered',
  'flat -> invalid: unknown-key',
  'flat -> invalid: upgrade',
  'flat -> licensed, entitled',
  'flat -> licensed, test, entitled',
  'null -> licensed',
  'partly malformed -> licensed, entitled',
]

/** Where a lease's end falls against the time it is judged at (`endSecond`): the second's both edges. */
const END_SECOND = ['judged at its end second', 'judged under a second past it', 'otherwise']

/** How the leases are held to a device, and what each gives (`heldTo`). */
const HELD_TO = [
  'held to no device',
  'hostname, another device: licensed',
  'machine, another device, on a run that cannot tell: licensed',
  'machine, another device: device',
  'machine, another device: tampered',
  'machine, no device claim: licensed',
  'machine, this device: licensed',
  'no claims',
  'no kind, another device: licensed',
]

/** Whose key the leases name, and what each gives (`keyNamed`). */
const KEY_NAMED = ['another key: tampered', 'no claims', 'the key in another case: licensed', 'the key stored']

/** A trial lease judged on a run that can tell who the device is, or cannot, and the status it gives. */
const TRIAL_JUDGED = ['cannot tell -> trial, entitled', 'tells -> expired: trial', 'tells -> trial', 'tells -> trial, entitled']

/** Every kind of `ent` a trial lease signs, and the trial's status (`trialStatusOf` of `trialLeaseOf`), as for a licence. */
const TRIAL_LEASE_STATUSES = [
  'a flag -> trial',
  'a list -> trial',
  'a number -> trial',
  'a text -> trial',
  'absent -> trial',
  'all malformed -> trial',
  'empty -> trial',
  'flat -> expired: trial',
  'flat -> trial, entitled',
  'null -> trial',
  'partly malformed -> trial, entitled',
]

const FIRST_COVERAGE: Record<FirstGroup, Record<string, Facet>> = {
  leases: {
    verdict: {
      of: leaseVerdict,
      expect: ['device', 'expired', 'licensed', 'licensed, test', 'outdated', 'tampered', 'unknown-key', 'upgrade'],
    },
    end: { of: endSecond, expect: END_SECOND },
    held: { of: heldTo, expect: HELD_TO },
    key: { of: keyNamed, expect: KEY_NAMED },
    verify: {
      of: (v) => {
        const r = obj(v.verify)
        return `${r.valid === true ? 'valid' : String(r.reason)}${r.claims !== undefined ? ', with claims' : ''}`
      },
      expect: ['bad-claims', 'bad-signature', 'expired, with claims', 'malformed', 'unknown-key', 'valid, with claims'],
    },
    unknownKey: {
      // Unknown-key is told before the lease's end is read: an expired one is answered the same.
      of: (v) => {
        if (obj(v.verify).reason !== 'unknown-key') return 'another'
        const exp = Number(payloadOf(v.token).exp)
        return exp * 1000 <= Number(v.now) ? 'unknown-key, expired' : 'unknown-key, live'
      },
      expect: ['another', 'unknown-key, expired', 'unknown-key, live'],
    },
    defaults: {
      of: (v) => {
        if (obj(v.verify).valid !== true) return 'not valid'
        const missing = ['major', 'ent'].filter((claim) => !(claim in payloadOf(v.token)))
        return missing.length > 0 ? `${missing.join(' and ')} defaulted` : 'nothing defaulted'
      },
      expect: ['ent defaulted', 'major defaulted', 'not valid', 'nothing defaulted'],
    },
    entitlements: {
      // How a lease that verified (or merely expired) signed `ent`, and what reading it kept.
      of: (v) => {
        const claims = obj(obj(v.verify).claims)
        if (!('ent' in claims)) return 'no claims'
        const kept = Object.keys(obj(claims.ent)).length > 0 ? 'some kept' : 'none kept'
        const expired = obj(v.verify).valid === true ? '' : 'expired, '
        return `${expired}${entSigned(v.token)}: ${kept}`
      },
      expect: [
        'a flag: none kept',
        'a list: none kept',
        'a number: none kept',
        'a text: none kept',
        'absent: none kept',
        'all malformed: none kept',
        'empty: none kept',
        'expired, empty: none kept',
        'expired, flat: some kept',
        'flat: some kept',
        'no claims',
        'null: none kept',
        'partly malformed: some kept',
      ],
    },
    ...entitlementSpecials((v) => obj(obj(obj(v.verify).claims).ent)),
  },
  trials: { judged: { of: judgedBy(answer), expect: ['cannot tell -> true', 'tells -> false', 'tells -> true'] } },
  fingerprintClaims: { input: { of: (v) => script(String(v.input)), expect: ['ascii', 'empty', 'non-ascii'] } },
  fingerprints: {
    raw: {
      of: (v) => {
        const raw = String(v.raw)
        if (raw === 'unknown-host') return 'the unknown host'
        if (raw.startsWith('machine-id|')) return 'a machine id'
        return raw === '' ? 'empty' : `a host, ${script(raw)}`
      },
      expect: ['a host, ascii', 'a host, non-ascii', 'a machine id', 'empty', 'the unknown host'],
    },
  },
  machineFingerprints: {
    id: {
      of: (v) => {
        const id = String(v.id)
        return id.includes('-') ? (/[A-F]/.test(id) ? 'a GUID in capitals' : 'a GUID') : 'hex'
      },
      expect: ['a GUID', 'a GUID in capitals', 'hex'],
    },
  },
  hostFingerprints: {
    platform: { of: (v) => String(v.platform), expect: ['darwin', 'linux', 'win32'] },
    arch: { of: (v) => String(v.arch), expect: ['arm', 'arm64', 'ia32', 'x64'] },
    host: { of: (v) => script(String(v.host)), expect: ['ascii', 'non-ascii'] },
  },
  kept: {
    outcome: {
      of: (v) => {
        const to = v.expect === null ? 'nothing' : v.expect === v.kept ? 'unchanged' : v.expect === 0 ? 'zero' : 'the build'
        return `${v.kept === null ? 'nothing kept' : 'a major kept'}: ${to}`
      },
      expect: ['a major kept: the build', 'a major kept: unchanged', 'nothing kept: nothing', 'nothing kept: the build', 'nothing kept: zero'],
    },
  },
  renew: { answer: { of: answer, expect: ['false', 'true'] } },
  asks: { answer: { of: answer, expect: ['false', 'true'] } },
  standing: { answer: { of: answer, expect: ['"device"', '"outdated"', '"revoked"', '"upgrade"', 'null'] } },
  trialStatuses: {
    state: {
      of: (v) => {
        const e = obj(v.expect)
        if (e.state !== 'trial') return String(e.state)
        return e.trialDaysLeft === undefined ? 'trial, no end known' : e.trialDaysLeft === 0 ? 'trial, 0 days left' : 'trial'
      },
      expect: ['expired', 'trial', 'trial, 0 days left', 'trial, no end known', 'unlicensed'],
    },
  },
  refusalPatches: {
    refused: {
      of: (v) => {
        const nobody = Array.isArray(obj(v.expect).refusedFor) && (obj(v.expect).refusedFor as unknown[]).length === 0
        return `${String(v.refused)}${nobody ? ', for nobody' : ''}`
      },
      expect: ['device', 'device, for nobody', 'outdated', 'revoked', 'upgrade'],
    },
  },
  leasePatches: { patch: { of: (v) => String(v.patch), expect: ['LEASED', 'UNKEYED'] } },
  keyedBy: { keyed: { of: (v) => ('deviceKind' in obj(v.expect) ? 'keyed' : 'not keyed'), expect: ['keyed', 'not keyed'] } },
  merges: {
    landed: {
      of: (v) => `${mergeBasis(v)}: ${mergeOutcome(v)}`,
      expect: [
        'about, another activation: trial evidence only',
        'about, the same activation: kept major kept highest',
        'about, the same activation: landed whole',
        'about, the same activation: landed whole, retired fields left out',
        'activation, another activation: landed whole',
        'activation, another activation: landed whole, retired fields left out',
        'activation, the same activation: landed whole',
        'activation, the same activation: verdict dropped',
        'answer, another activation: trial evidence only',
        'answer, another activation: verdict dropped',
        'answer, the same activation: kept major kept highest',
        'answer, the same activation: landed whole',
        'answer, the same activation: landed whole, retired fields left out',
        'answer, the same activation: verdict dropped',
        'trial: landed whole',
        'trial: landed whole, retired fields left out',
        'trial: trial answer dropped',
        'unbased: landed whole',
        'unbased: landed whole, a report stamped',
        'unbased: landed whole, retired fields left out',
        'unbased: trial start kept earliest',
      ],
    },
  },
  guardedNow: { guard: { of: (v) => (v.expect === v.clockNow ? 'the clock' : 'last seen'), expect: ['last seen', 'the clock'] } },
  clockCorrections: {
    corrected: {
      of: (v) => (v.expect === null ? 'left' : v.expect === v.clockNow ? 'the clock' : 'the signing time'),
      expect: ['left', 'the clock', 'the signing time'],
    },
  },
  mapServerError: {
    answer: { of: answer, expect: ['"invalid-key"', '"limit"', '"network"', '"outdated"', '"revoked"', '"upgrade"'] },
  },
  refusalOf: { answer: { of: answer, expect: ['"device"', '"outdated"', '"revoked"', '"upgrade"', 'null'] } },
  enteredKey: {
    key: {
      of: (v) => (v.expect === null ? 'refused' : v.expect === v.input ? 'as entered' : 'normalised'),
      expect: ['as entered', 'normalised', 'refused'],
    },
  },
  trimDeviceName: { cut: { of: trimOutcome, expect: ['cut', 'cut after a pair', 'cut before a pair', 'whole'] } },
  noAnswer: { answer: { of: answer, expect: ['false', 'true'] } },
  parseLeaseBody: {
    fields: {
      of: (v) => Object.keys(obj(v.expect)).sort().join(' and ') || 'nothing',
      expect: ['activationId and lease', 'lease', 'nothing'],
    },
  },
  parseTrialBody: {
    body: {
      of: (v) => (v.expect === null ? 'refused' : 'lease' in obj(v.expect) ? 'with a lease' : 'without a lease'),
      expect: ['refused', 'with a lease', 'without a lease'],
    },
  },
  mountinfo: { answer: { of: answer, expect: ['"btrfs"', '"ext4"', '"overlay"', '"ramfs"', '"tmpfs"', 'null'] } },
  machineIds: {
    reading: {
      of: (v) => `${String(obj(v.source).platform)}: ${String(obj(v.expect).kind)}`,
      expect: ['darwin: id', 'darwin: transient', 'darwin: unavailable', 'linux: id', 'linux: transient', 'linux: unavailable', 'win32: id', 'win32: transient', 'win32: unavailable'],
    },
  },
  renewals: renewalFacets(),
  validLeaseAsks: { answer: { of: answer, expect: ['false', 'true'] } },
  devices: {
    device: {
      of: (v) => {
        const d = obj(v.expect)
        const kind = typeof d.kind === 'string' ? d.kind : 'no kind'
        return `${d.canTell === true ? 'tells' : 'cannot tell'}, ${kind}, ${d.own === null ? 'no own' : 'own'}, ${d.hostname === null ? 'no host name' : 'a host name'}`
      },
      expect: [
        'cannot tell, no kind, no own, a host name',
        'cannot tell, no kind, no own, no host name',
        'cannot tell, no kind, own, a host name',
        'cannot tell, no kind, own, no host name',
        'tells, hostname, own, a host name',
        'tells, machine, own, a host name',
        'tells, no kind, own, no host name',
      ],
    },
  },
  identities: {
    identity: {
      of: (v) => {
        const i = obj(v.expect)
        const alternates = Array.isArray(i.alternates) ? i.alternates.length : -1
        return `${typeof i.kind === 'string' ? i.kind : 'no fingerprint'}, ${alternates} alternate${alternates === 1 ? '' : 's'}`
      },
      expect: ['hostname, 0 alternates', 'machine, 0 alternates', 'machine, 1 alternate', 'no fingerprint, 1 alternate'],
    },
    host: { of: (v) => (v.host === null ? 'host names unreadable' : 'host names read'), expect: ['host names read', 'host names unreadable'] },
  },
  savedLastSeen: {
    saved: {
      of: (v) => (v.guard !== null ? 'the guard' : v.expect === v.clockNow ? 'the clock' : 'last seen'),
      expect: ['last seen', 'the clock', 'the guard'],
    },
  },
  leaseStatuses: {
    signed: signedToStatus(LEASE_STATUSES),
    ...entitlementSpecials((v) => obj(obj(v.expect).entitlements), ['a name __proto__']),
  },
  trialLeaseStatuses: {
    signed: signedToStatus(TRIAL_LEASE_STATUSES),
    judged: { of: judgedBy((v) => statusShape(v.expect)), expect: TRIAL_JUDGED },
    ...entitlementSpecials((v) => obj(obj(v.expect).entitlements), ['a name __proto__']),
  },
  entitlementNumbers: {
    form: { of: numberForm, expect: ['a fraction', 'a fraction, negative', 'a whole number', 'a whole number, negative', 'an exponent'] },
    range: { of: numberRange, expect: ['a subnormal', 'in between', 'the largest double', 'the smallest normal', 'the smallest subnormal'] },
    misread: { of: (v) => (MISREAD.includes(String(v.json)) ? String(v.json) : 'another number'), expect: [...MISREAD, 'another number'] },
  },
}

/**
 * Every group's facets: the first groups', then the later groups'
 * (`coverage-later.ts`), the key-set groups' (`coverage-keys.ts`), the
 * licence-file groups' (`coverage-files.ts`), the user-lock groups'
 * (`coverage-user-lock.ts`) and the metered-uses groups' (`coverage-meters.ts`).
 */
export const COVERAGE: Record<GroupName, Record<string, Facet>> = { ...FIRST_COVERAGE, ...LATER_COVERAGE, ...KEY_COVERAGE, ...FILE_COVERAGE, ...USER_LOCK_COVERAGE, ...METER_COVERAGE, ...PICKUP_COVERAGE }
