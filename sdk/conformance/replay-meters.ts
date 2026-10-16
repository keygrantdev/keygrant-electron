/**
 * How the metered-uses groups (`MeterGroup`) are answered by the reference, from each vector's own
 * JSON inputs, as `replay.ts` answers the others (and with its conventions). They come after every
 * other group in the file.
 */
import { metersOf } from '@keygrant/shared'
import { journaled } from '../src/journal.js'
import { askedFor, figuresOf, meterStatusOf, offlineSpend, spendsConfirmed, spendsReported, useAsksNow, useOutcome } from '../src/meters.js'
import type { GroupInputs, GroupName, MeterGroup } from './inputs.js'
import { ANSWERS, encodePatch, plain, type Group } from './replay.js'

/** `x ?? undefined`, for the optional inputs JSON writes as null. */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value)

/**
 * A group of `replay.ts` answered as it is. `replay.ts` imports this module, so the group is read when
 * an answer is asked for, never when this module loads.
 */
const likeGroup = <G extends GroupName>(name: G): Group<GroupInputs[G]> => ({
  get outputs() {
    return ANSWERS[name].outputs
  },
  answer: (input, keys) => ANSWERS[name].answer(input, keys),
})

export const METERS: { [G in MeterGroup]: Group<GroupInputs[G]> } = {
  meterClaims: {
    outputs: ['expect'],
    // A lease without the claim has none to read: metersOf of nothing.
    answer: (i) => ({ expect: plain(metersOf(i.json === null ? undefined : JSON.parse(i.json))) }),
  },
  // A lease carrying `met` is verified and judged as any other, and its claims carry the meters as read.
  meterLeases: likeGroup('leases'),
  useAmounts: {
    outputs: ['expect'],
    // A vector with no `n` is a call that gave none.
    answer: (i) => ({ expect: plain(askedFor(i.meter, 'n' in i ? i.n : undefined)) }),
  },
  meterFigures: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(figuresOf(i.met, i.iat, i.figures)) }),
  },
  meterStatuses: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(meterStatusOf(i.figures, i.spends)) }),
  },
  offlineSpends: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(offlineSpend(i.figures, i.spends, i.meter, i.n)) }),
  },
  useAsks: {
    outputs: ['expect'],
    answer: (i) => ({ expect: useAsksNow({ state: i.state, clockNow: i.clockNow, now: i.now, covered: i.covered }) }),
  },
  syncAsks: likeGroup('validLeaseAsks'),
  useOutcomes: {
    outputs: ['expect'],
    answer: (i) => {
      const device = { kind: opt(i.device.kind), ownClaim: opt(i.device.ownClaim) }
      const outcome = useOutcome({ response: i.response, askedAt: i.askedAt, major: i.major, device })
      return { expect: plain({ ...outcome, patch: encodePatch(outcome.patch) }) }
    },
  },
  journals: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(journaled(i.latest, i.op, i.now)) }),
  },
  spendReports: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(spendsReported(i.spends)) }),
  },
  spendConfirmations: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(spendsConfirmed(i.response)) }),
  },
}
