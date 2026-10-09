/**
 * The SDK conformance vectors: what every KeyGrant SDK, in any language, must
 * answer for the same inputs.
 *
 * The Electron SDK is the reference. The functions under `vectors/` make the
 * inputs (leases signed with a TEST-ONLY key, states, patches, devices and
 * machine-id scripts), the reference answers each one from its JSON
 * (`replay.ts` `GROUPS`), and this file writes the lot to
 * `conformance/vectors.json` at the repo root. Each SDK's test suite loads that
 * file and must reproduce every answer; `src/conformance.test.ts` fails when
 * the file does not match what the reference answers, and replays the file
 * itself through the reference.
 *
 *   pnpm --filter @keygrant/electron run conformance    # rewrite conformance/vectors.json
 *
 * Every input must survive JSON unchanged (it is checked): an answer is only
 * ever computed from what the file can carry. Everything is deterministic:
 * Ed25519 signatures are, and every time is fixed. A group only ever grows at
 * its end, and new groups come after the old ones.
 */
import { deepStrictEqual } from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importVerifyingKey, OPEN_MAJOR } from '@keygrant/shared'
import { ASK_AGAIN_MS, CLAIM_EAGER_MS, CLAIM_WAIT_MS, PURCHASE_TOKEN_MS, RENEW_WITHIN_MS, RETRY_UNANSWERED_MS, TRIAL_REPORT_MS } from '../src/offline.js'
import { MAX_CLAIM_FINGERPRINTS, MAX_CLAIM_FINGERPRINT_LENGTH, PURCHASE_REFERENCE_PREFIX } from '../src/pickup.js'
import { CLOCK_TOLERANCE_MS } from '../src/clock.js'
import { MAX_DEVICE_NAME, MAX_KEY, STATUS_CHECK_TIMEOUT_MS } from '../src/wire.js'
import { DEFAULT_HTTP_TIMEOUT_MS, KEEP_CORRUPT, STALE_TEMP_MS, UNKNOWN_HOST } from '../src/adapters.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, BOOT_SLACK_MS, MACHINE_ID_TIMEOUT_MS } from '../src/machine-id.js'
import { LOCK_GRACE_MS } from '../src/engine.js'
import { UPDATE_ATTEMPTS } from '../src/storage.js'
import type { GroupInputs, GroupName } from './inputs.js'
import { GROUPS } from './replay.js'
import { TEST_PUBLIC_JWK, context, type Context } from './vectors/common.js'
import { leases } from './vectors/leases.js'
import { trials } from './vectors/trials.js'
import { devices, fingerprintClaims, fingerprints, hostFingerprints, identities, machineFingerprints } from './vectors/fingerprints.js'
import { asks, kept, keyedBy, leasePatches, majors, refusalPatches, renew, standing, trialStatuses, validLeaseAsks } from './vectors/decisions.js'
import { merges } from './vectors/merges.js'
import { clockCorrections, guardedNow, savedLastSeen } from './vectors/clock.js'
import { enteredKey, mapServerError, noAnswer, parseLeaseBody, parseTrialBody, refusalOf, trimDeviceName } from './vectors/wire.js'
import { machineIds, mountinfo } from './vectors/machine-id.js'
import { renewals } from './vectors/renewals.js'
import { leaseStatuses, trialLeaseStatuses } from './vectors/statuses.js'
import { entitlementNumbers } from './vectors/numbers.js'
import {
  claimBodies,
  claimDue,
  claimOutcomes,
  parseClaimBody,
  purchaseReferences,
  purchaseTokenKept,
  purchaseUrls,
  trialReportDue,
} from './vectors/purchases.js'

export { TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from './vectors/common.js'

/** Every group's inputs, built (each typed by its group, `GroupInputs`). */
const BUILDERS: { [G in GroupName]: (ctx: Context) => GroupInputs[G][] | Promise<GroupInputs[G][]> } = {
  leases,
  trials,
  fingerprintClaims,
  fingerprints,
  machineFingerprints,
  hostFingerprints,
  kept,
  renew,
  asks,
  standing,
  trialStatuses,
  refusalPatches,
  leasePatches,
  keyedBy,
  merges,
  guardedNow,
  clockCorrections,
  mapServerError,
  refusalOf,
  enteredKey,
  trimDeviceName,
  noAnswer,
  parseLeaseBody,
  parseTrialBody,
  mountinfo,
  machineIds,
  renewals,
  validLeaseAsks,
  devices,
  identities,
  savedLastSeen,
  leaseStatuses,
  trialLeaseStatuses,
  entitlementNumbers,
  majors,
  purchaseUrls,
  purchaseTokenKept,
  claimDue,
  parseClaimBody,
  claimOutcomes,
  trialReportDue,
  purchaseReferences,
  claimBodies,
}

const COMMENT =
  'Generated from the KeyGrant Electron SDK (the reference). Every KeyGrant SDK must reproduce every answer: "expect", and also "verify", "claim" and "fingerprint". Signed with a TEST-ONLY key. Do not edit; regenerate.'

const CONVENTIONS = [
  'Times are milliseconds since the epoch; lease claims (iat, exp, upgradeUntil) are seconds.',
  'A state is a stored state with absent fields unset.',
  'In a patch (merges.patch, and every patch an expect holds), null means the field is cleared and an absent field is left as it is.',
  'An answer of nothing (undefined or null) is null.',
  'verify.claims are the claims as parsed, defaults applied (major 0, ent {}), present for a valid or merely expired lease; ent is read leniently: its flag, number and text members kept, any other member dropped, and anything but an object read as {} (never a refusal).',
  "machineIds.source scripts the reference's reads: a file's content or error (unlisted: ENOENT) and when it was written; a command's output or error. An SDK that reads the id another way (the registry API, IOKit) reproduces the Linux cases and the decisions they pin.",
  "renewals.response is the validate's answer (its status and JSON body, null for none), null when there was none at all (it threw or timed out); renewals.check is the SDK's offline check of the lease a 200 carried, made as of renewals.now (as leases.expect, with the lease's claims when ok), null when it carried none; renewals.expect.patch is what is saved, as the answer to the ask.",
  'Inside an answer that is an object (devices.expect, identities.expect, renewals.expect.status, trialStatuses.expect, leaseStatuses.expect, trialLeaseStatuses.expect), a member with no value is left out; devices.identity.kind and identities.host are null for none.',
  'A status (renewals.expect.status, leaseStatuses.expect, trialLeaseStatuses.expect) carries entitlements only when the lease grants any: an empty map is left out, as test is when false. Numbers in it are doubles, read correctly rounded (entitlementNumbers pins their bits): compare them as numbers, 5 and 5.0 alike.',
  'trialLeaseStatuses: the stored state is the trial start and the trial lease (trialStart, trialLease = token), the lease judged for device as trials judges it.',
  'entitlementNumbers.json is a number as the server writes it (JSON.stringify); entitlementNumbers.expect is the IEEE-754 bits, sign first, as 16 lowercase hex digits, of the double an ent member reads from it (entitlementsOf of {"n": json}): a reader that rounds wrongly fails here though it reads the file and a lease alike.',
  "majors: the major a build configured as configured (null: none) runs as, 0.x read as 1 as the server reads it. A vector marked jsOnly holds a fraction, which no typed port's config can hold, and every typed port skips it; a negative is not marked, and only a port whose major type is unsigned skips it.",
  "purchaseUrls: the link purchaseUrl answers for the held secret: link with purchaseReferences' reference for secret as its one client_reference_id. The link is read as an absolute URL (every link here is already in its normal form), and its query is edited as text: each parameter named exactly client_reference_id (the text before its first =, or all of it) and each empty one left out, the others kept as written and in order, client_reference_id=<reference> added last (a reference needs no escaping), the fragment kept. upgradeUrl builds its link the same way, with the activation id.",
  "purchaseReferences: the reference a link carries for a purchase secret: kgp_ and the base64url (no padding) of the SHA-256 of the secret's UTF-8 bytes. The secret stays on the device and is sent only in the claim.",
  "purchaseTokenKept, claimDue and trialReportDue take a stored state; purchaseTokenKept and trialReportDue judge it at now (the guarded clock); claimDue judges the link's freshness (purchaseTokenAt) at now and the wait (claimAskedAt) at clockNow (the device clock).",
  'parseClaimBody.expect keeps key, activationId and lease when they are strings, pending only when it is true, error only when it is a string of at least one character; every other member, and a body that is not an object, gives nothing ({}).',
  "claimOutcomes.response is the claim's answer (null for none at all); claimOutcomes.check is the SDK's offline check of the lease a 200 carried with key, activationId and lease (as leases.expect, with the claims when ok), null otherwise; claimOutcomes.kind is what the claim's fingerprint hashes (null for none). expect.result is bought, kept or dropped; expect.status is the status a bought key gives (null otherwise); expect.patch is the patch, with no stamp in it: a bought key's is saved with basis activation {at: the ask's guarded time, activationId, seen: the stored verdictAt}, which stamps verdictAt; a kept secret's with basis purchase {token: the secret, at: the purchaseTokenAt the ask read}; a dropped one's with basis purchase {token: the secret}.",
  'claimBodies: the body a claim sends, null when none is sent. The device is deviceFrom(identity, no install kind, deviceHold), as the devices group reads one; start is true for startTrial(), false for status() and refresh(). fingerprints counts characters in UTF-16 units, as the server does; deviceName is the name already cut (trimDeviceName), null for none; major is the major already read (majors).',
]

export async function generate() {
  const verifying = await importVerifyingKey(TEST_PUBLIC_JWK as JsonWebKey)
  const ctx = await context()
  const groups: Record<string, unknown[]> = {}
  for (const group of Object.keys(GROUPS) as GroupName[]) {
    groups[group] = await answered(group, await BUILDERS[group](ctx), verifying)
  }
  return {
    $comment: COMMENT,
    conventions: CONVENTIONS,
    publicJwk: TEST_PUBLIC_JWK,
    constants: {
      OPEN_MAJOR,
      ASK_AGAIN_MS,
      RETRY_UNANSWERED_MS,
      RENEW_WITHIN_MS,
      CLOCK_TOLERANCE_MS,
      STATUS_CHECK_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUT_MS,
      LOCK_GRACE_MS,
      MACHINE_ID_TIMEOUT_MS,
      ACTIVATE_MACHINE_ID_TIMEOUT_MS,
      BOOT_SLACK_MS,
      MAX_DEVICE_NAME,
      MAX_KEY,
      KEEP_CORRUPT,
      STALE_TEMP_MS,
      UPDATE_ATTEMPTS,
      UNKNOWN_HOST,
      CLAIM_WAIT_MS,
      PURCHASE_TOKEN_MS,
      TRIAL_REPORT_MS,
      PURCHASE_REFERENCE_PREFIX,
      CLAIM_EAGER_MS,
      MAX_CLAIM_FINGERPRINTS,
      MAX_CLAIM_FINGERPRINT_LENGTH,
    },
    ...groups,
  }
}

/**
 * A group's vectors: each input with the reference's answers, computed from
 * exactly what the file will carry, or the generator stops: an answer is never
 * computed from anything JSON cannot say.
 */
async function answered(group: GroupName, inputs: readonly object[], key: CryptoKey): Promise<unknown[]> {
  if (inputs.length === 0) throw new Error(`the group ${group} has no vectors`)
  const vectors: unknown[] = []
  for (const input of inputs) {
    const carried = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    deepStrictEqual(carried, input, `${group}: an input does not survive JSON`)
    vectors.push({ ...carried, ...(await GROUPS[group].answer(carried, key)) })
  }
  return vectors
}

export const VECTORS_PATH = fileURLToPath(new URL('../../conformance/vectors.json', import.meta.url))

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const vectors = await generate()
  writeFileSync(VECTORS_PATH, `${JSON.stringify(vectors, null, 2)}\n`)
  console.log(`wrote ${VECTORS_PATH}`)
}
