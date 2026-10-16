/**
 * What each metered-uses group (`MeterGroup`) must cover, as `coverage.ts` says of the others: every
 * outcome its decision gives keeps a vector. Each group's `rule` facet also tells every vector apart
 * (`src/conformance.test.ts` checks no two share one), by its inputs and what it shows, so deleting any
 * vector, not only the last of an outcome, fails.
 */
import type { MeterGroup } from './inputs.js'
import { STATE_RULES } from './rules-meters-state.js'
import { WIRE_RULES } from './rules-meters-wire.js'
import { answer, leaseVerdict, obj, type Facet, type Vector } from './facets.js'
import {
  askedRule,
  asksRule,
  claimRule,
  confirmationRule,
  figuresRule,
  journalRule,
  leaseMetRule,
  offlineRule,
  outcomeRule,
  reportRule,
  statusRule,
  syncRule,
} from './facets-meters.js'

const BOOLEAN = ['false', 'true']

/** The rule of every vector, by group: what each of them uniquely shows. */
const RULES = { ...STATE_RULES, ...WIRE_RULES }

/** How many meters an answer holds. */
const meterCount = (v: Vector) => `${Object.keys(obj(v.expect)).length} meters`

export const METER_COVERAGE: Record<MeterGroup, Record<string, Facet>> = {
  meterClaims: {
    rule: {
      of: claimRule,
      expect: RULES.meterClaims,
    },
    kept: {
      of: meterCount,
      expect: [
        "0 meters",
        "1 meters",
        "2 meters",
        "9 meters",
      ],
    },
    resets: {
      of: (v) => (Object.values(obj(v.expect)).some((m) => obj(m).resets === true) ? 'a meter that resets is read' : 'none that resets'),
      expect: ['a meter that resets is read', 'none that resets'],
    },
  },
  meterLeases: {
    rule: {
      of: leaseMetRule,
      expect: RULES.meterLeases,
    },
    verdict: {
      of: leaseVerdict,
      expect: [
        "expired",
        "licensed",
        "licensed, test",
        "tampered",
        "upgrade",
      ],
    },
  },
  useAmounts: {
    rule: {
      of: askedRule,
      expect: RULES.useAmounts,
    },
    answer: { of: (v) => ('refused' in obj(v.expect) ? `refused ${String(obj(v.expect).refused)}` : 'asked'), expect: ['asked', 'refused invalid-amount', 'refused no-meter'] },
    ports: { of: (v) => (v.jsOnly === true ? 'js only' : 'every port'), expect: ['every port', 'js only'] },
  },
  meterFigures: {
    rule: {
      of: figuresRule,
      expect: RULES.meterFigures,
    },
    kept: {
      of: meterCount,
      expect: [
        "0 meters",
        "1 meters",
        "2 meters",
        "3 meters",
      ],
    },
  },
  meterStatuses: {
    rule: {
      of: statusRule,
      expect: RULES.meterStatuses,
    },
    kept: {
      of: meterCount,
      expect: [
        "0 meters",
        "1 meters",
        "2 meters",
      ],
    },
  },
  offlineSpends: {
    rule: {
      of: offlineRule,
      expect: RULES.offlineSpends,
    },
    answer: {
      of: (v) => {
        const e = obj(v.expect)
        return e.ok === true ? 'allowed' : `refused ${String(e.error)}`
      },
      expect: ['allowed', 'refused no-meter', 'refused offline-limit'],
    },
  },
  useAsks: {
    rule: {
      of: asksRule,
      expect: RULES.useAsks,
    },
    answer: { of: answer, expect: BOOLEAN },
  },
  syncAsks: {
    rule: {
      of: syncRule,
      expect: RULES.syncAsks,
    },
    answer: { of: answer, expect: BOOLEAN },
  },
  useOutcomes: {
    rule: {
      of: outcomeRule,
      expect: RULES.useOutcomes,
    },
    outcome: {
      of: (v) => `${String(obj(v.expect).outcome)}${obj(v.expect).refusal !== undefined ? ` ${String(obj(v.expect).refusal)}` : ''}`,
      expect: [
        "no-meter",
        "refused device",
        "refused outdated",
        "refused revoked",
        "refused upgrade",
        "spent",
        "unanswered",
        "used-up",
      ],
    },
  },
  journals: {
    rule: {
      of: journalRule,
      expect: RULES.journals,
    },
    op: { of: (v) => String(obj(v.op).kind), expect: ['activated', 'confirmed', 'deactivated', 'figures', 'offline', 'unanswered', 'void'] },
    refused: { of: (v) => String(obj(v.expect).refused), expect: BOOLEAN },
  },
  spendReports: {
    rule: {
      of: reportRule,
      expect: RULES.spendReports,
    },
  },
  spendConfirmations: {
    rule: {
      of: confirmationRule,
      expect: RULES.spendConfirmations,
    },
  },
}
