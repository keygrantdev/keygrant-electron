/**
 * What each purchase group (`LaterGroup`) must cover, as `coverage.ts` says of
 * the others: every outcome its decision gives keeps a vector, and each
 * vector's own rule is an outcome of its own (facets-purchase.ts), so deleting
 * the only vector of a rule fails.
 */
import type { LaterGroup } from './inputs.js'
import { answer, obj, type Facet } from './facets.js'
import {
  claimBodyBound,
  claimBodyFingerprints,
  claimBodySent,
  claimDueClocks,
  claimKept,
  claimRow,
  claimStatus,
  linkRule,
  majorRead,
  parseRule,
  stampEdge,
} from './facets-purchase.js'

/** Every edge `stampEdge` tells apart. */
const EDGES = ['a millisecond inside', 'ahead', 'at the bound', 'inside', 'none', 'past']

const BOOLEAN = { of: answer, expect: ['false', 'true'] }

export const LATER_COVERAGE: Record<LaterGroup, Record<string, Facet>> = {
  majors: {
    read: {
      of: majorRead,
      expect: [
        '0 -> 1',
        '1 -> as it is',
        'a fraction over 1 -> 1',
        'a fraction over 1 -> 2',
        'a fraction under 1 -> 1',
        'a negative -> 1',
        'a negative fraction -> 1',
        'absent -> 1',
        'over 1 -> as it is',
      ],
    },
    ports: {
      of: (v) => (v.jsOnly === true ? 'js only' : Number(v.configured) < 0 ? 'a negative, every port' : 'every port'),
      expect: ['a negative, every port', 'every port', 'js only'],
    },
  },
  purchaseUrls: {
    rule: {
      of: linkRule,
      expect: [
        'a bare client_reference_id',
        'a client_reference_id',
        'a fragment after parameters',
        'a fragment, no query',
        'a name only starting with client_reference_id',
        'a port and a deeper path',
        'an = in a value',
        'an empty query',
        'empty parameters',
        'no query',
        'other parameters',
        'two client_reference_ids',
      ],
    },
  },
  purchaseTokenKept: {
    answer: BOOLEAN,
    edge: {
      of: (v) => {
        const state = obj(v.state)
        if (typeof state.purchaseToken !== 'string') return 'no token'
        return stampEdge(state.purchaseTokenAt, Number(v.now), 30 * 86_400_000)
      },
      expect: [...EDGES, 'no token'],
    },
  },
  claimDue: {
    answer: BOOLEAN,
    edge: { of: (v) => stampEdge(obj(v.state).claimAskedAt, Number(v.clockNow), 5 * 60_000), expect: EDGES },
    fresh: { of: (v) => stampEdge(obj(v.state).purchaseTokenAt, Number(v.now), 86_400_000), expect: EDGES },
    clocks: {
      of: claimDueClocks,
      expect: ['one time', 'two clocks: due', 'two clocks: stale by the guarded clock', 'two clocks: waiting by the device clock'],
    },
  },
  parseClaimBody: {
    fields: {
      of: (v) => Object.keys(obj(v.expect)).sort().join(' and ') || 'nothing',
      expect: ['activationId and key and lease', 'error', 'key and lease', 'nothing', 'pending'],
    },
    rule: {
      of: parseRule,
      expect: [
        'a number',
        'a string',
        'an array',
        'an empty error',
        'an empty object',
        'an error not a string',
        'an error word',
        'members kept one by one',
        'members not strings',
        'null',
        'pending false',
        'pending not true',
        'pending true',
        'unknown members ignored',
      ],
    },
  },
  claimOutcomes: {
    rows: {
      of: (v) => `${claimRow(v)}: ${String(obj(v.expect).result)}`,
      expect: [
        '200, a key, also an error word: bought',
        '200, a key, also pending: bought',
        '200, a key: does not license: dropped',
        '200, a key: licenses: bought',
        '200, an error word: dropped',
        '200, key and lease without an activation: kept',
        '200, no error word: kept',
        '200, not JSON: kept',
        '200, pending not true: kept',
        '200, pending: kept',
        'a 429: kept',
        'a 5xx with an error word: kept',
        'a 5xx: kept',
        'an empty error: kept',
        'another status, an error word: dropped',
        'another status, no error word: kept',
        'another status, not JSON: kept',
        'no answer: kept',
      ],
    },
    status: { of: claimStatus, expect: ['licensed', 'licensed, entitled', 'licensed, test', 'no status'] },
    kept: { of: claimKept, expect: ['bought, no kept major', 'bought, the build kept', 'not bought'] },
    kind: {
      of: (v) => (obj(v.expect).result === 'bought' ? `bought, ${typeof v.kind === 'string' ? v.kind : 'no kind'}` : 'not bought'),
      expect: ['bought, hostname', 'bought, machine', 'bought, no kind', 'not bought'],
    },
    failed: {
      of: (v) => (v.check !== null && obj(v.check).ok === false ? String(obj(v.check).reason) : 'no failed check'),
      expect: ['device', 'expired', 'no failed check', 'outdated', 'tampered', 'upgrade'],
    },
  },
  claimBodies: {
    sent: {
      of: claimBodySent,
      expect: [
        'nothing sent, startTrial',
        'nothing sent, status',
        'sent, machine',
        'sent, no kind, held',
        'sent, no kind, not held',
        'sent, the host name read',
        'sent, the host-name fallback at startTrial',
      ],
    },
    bound: {
      of: claimBodyBound,
      expect: ['counted in UTF-16 units', 'empty', 'its own too long', 'nothing sent', 'over four', 'too long', 'within the bounds'],
    },
    fingerprints: {
      of: claimBodyFingerprints,
      expect: [
        'every one read, held, its own not read',
        'every one read, held, its own read',
        'every one read, not held, its own not read',
        'every one read, not held, its own read',
        'nothing sent',
        'some left out, held, its own read',
      ],
    },
    name: { of: (v) => (v.deviceName === null ? 'no name' : 'a name'), expect: ['a name', 'no name'] },
  },
  purchaseReferences: {
    secret: { of: (v) => (/[-_]/.test(String(v.secret)) ? 'with - or _' : 'letters and digits only'), expect: ['letters and digits only', 'with - or _'] },
    reference: { of: (v) => (/^kgp_[A-Za-z0-9_-]{43}$/.test(String(v.expect)) ? 'kgp_ and 43 characters' : 'another shape'), expect: ['kgp_ and 43 characters'] },
  },
  trialReportDue: {
    answer: BOOLEAN,
    stamps: {
      of: (v) => {
        const state = obj(v.state)
        const stamps = ['trialAt', 'trialReportedAt'].filter((field) => field in state)
        return `${stamps.join(' and ') || 'none'} -> ${String(v.expect)}`
      },
      expect: ['none -> true', 'trialAt -> false', 'trialAt -> true', 'trialAt and trialReportedAt -> false', 'trialAt and trialReportedAt -> true', 'trialReportedAt -> false', 'trialReportedAt -> true'],
    },
    trialAt: { of: (v) => stampEdge(obj(v.state).trialAt, Number(v.now), 86_400_000), expect: EDGES },
    trialReportedAt: { of: (v) => stampEdge(obj(v.state).trialReportedAt, Number(v.now), 86_400_000), expect: EDGES },
  },
}
