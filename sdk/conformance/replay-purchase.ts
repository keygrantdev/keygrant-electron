/**
 * How the purchase groups (`LaterGroup`) are answered by the reference, from
 * each vector's own JSON inputs, as `replay.ts` answers the others (and with
 * its conventions). They come after every other group in the file.
 */
import { majorOf } from '../src/offline.js'
import { claimDue, claimOutcome, claimRequest, purchaseLink, purchaseReference, purchaseTokenKept, type ClaimOutcome } from '../src/pickup.js'
import { deviceFrom } from '../src/device.js'
import type { DeviceIdentity } from '../src/types.js'
import { parseClaimBody } from '../src/wire.js'
import { trialReportDue } from '../src/trials.js'
import type { GroupInputs, IdentityJson, LaterGroup } from './inputs.js'
import { encodePatch, plain, type Group } from './replay.js'

/** `x ?? undefined`, for the optional inputs JSON writes as null. */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value)

/** A fingerprinter's answer from a vector: no kind (null) is none. */
function identityFrom(given: IdentityJson): DeviceIdentity {
  const { fingerprint, alternates } = given
  return given.kind === null ? { fingerprint, alternates } : { fingerprint, kind: given.kind, alternates }
}

/** A claim's outcome as JSON says it: the result, the status as `plain`, the patch as a patch. */
function claimJson(outcome: ClaimOutcome): unknown {
  return { result: outcome.result, status: plain(outcome.status), patch: encodePatch(outcome.patch) }
}

export const LATER: { [G in LaterGroup]: Group<GroupInputs[G]> } = {
  majors: {
    outputs: ['expect'],
    answer: (i) => ({ expect: majorOf(opt(i.configured)) }),
  },
  purchaseUrls: {
    outputs: ['expect'],
    answer: (i) => ({ expect: purchaseLink(i.link, i.secret) }),
  },
  purchaseTokenKept: {
    outputs: ['expect'],
    answer: (i) => ({ expect: purchaseTokenKept(i.state, i.now) }),
  },
  claimDue: {
    outputs: ['expect'],
    answer: (i) => ({ expect: claimDue(i.state, i.clockNow, i.now) }),
  },
  parseClaimBody: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(parseClaimBody(i.body)) }),
  },
  claimOutcomes: {
    outputs: ['expect'],
    answer: (i) => {
      const check = i.check !== null ? { check: i.check } : {}
      const kind = i.kind !== null ? { kind: i.kind } : {}
      return { expect: claimJson(claimOutcome({ response: i.response, ...check, clockNow: i.clockNow, now: i.now, major: i.major, ...kind })) }
    },
  },
  trialReportDue: {
    outputs: ['expect'],
    answer: (i) => ({ expect: trialReportDue(i.state, i.now) }),
  },
  purchaseReferences: {
    outputs: ['expect'],
    answer: (i) => ({ expect: purchaseReference(i.secret) }),
  },
  claimBodies: {
    outputs: ['expect'],
    async answer(i) {
      const device = await deviceFrom(identityFrom(i.identity), undefined, i.deviceHold)
      const name = i.deviceName !== null ? { name: i.deviceName } : {}
      return { expect: plain(claimRequest({ secret: i.secret, device, ...name, major: i.major, start: i.start })) }
    },
  },
}
