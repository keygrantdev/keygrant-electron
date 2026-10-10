/**
 * How the groups after the first ones (`LaterGroup`) are answered by the
 * reference, from each vector's own JSON inputs, as `replay.ts` answers the
 * others (and with its conventions). They come after every other group in the
 * file.
 */
import { majorOf } from '../src/offline.js'
import { referencedLink } from '../src/link.js'
import { trialReportDue } from '../src/trials.js'
import type { GroupInputs, LaterGroup } from './inputs.js'
import type { Group } from './replay.js'

/** `x ?? undefined`, for the optional inputs JSON writes as null. */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value)

export const LATER: { [G in LaterGroup]: Group<GroupInputs[G]> } = {
  majors: {
    outputs: ['expect'],
    answer: (i) => ({ expect: majorOf(opt(i.configured)) }),
  },
  referencedLinks: {
    outputs: ['expect'],
    answer: (i) => ({ expect: referencedLink(i.link, i.reference) }),
  },
  trialReportDue: {
    outputs: ['expect'],
    answer: (i) => ({ expect: trialReportDue(i.state, i.now) }),
  },
}
