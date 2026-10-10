/**
 * What each group after the first ones (`LaterGroup`) must cover, as
 * `coverage.ts` says of the others: every outcome its decision gives keeps a
 * vector, and each vector's own rule is an outcome of its own
 * (facets-later.ts), so deleting the only vector of a rule fails.
 */
import type { LaterGroup } from './inputs.js'
import { answer, obj, type Facet } from './facets.js'
import { linkRule, majorRead, stampEdge } from './facets-later.js'

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
  referencedLinks: {
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
