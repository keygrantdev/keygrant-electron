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
import { importVerifyingKeys, MAX_LICENSE_FILE_BYTES, OPEN_MAJOR, type VerifyingKey } from '@keygrant/shared'
import { ASK_AGAIN_MS, RENEW_WITHIN_MS, RETRY_UNANSWERED_MS, TRIAL_REPORT_MS } from '../src/offline.js'
import { CLOCK_TOLERANCE_MS } from '../src/clock.js'
import { MAX_DEVICE_NAME, MAX_KEY, STATUS_CHECK_TIMEOUT_MS } from '../src/wire.js'
import { DEFAULT_HTTP_TIMEOUT_MS, KEEP_CORRUPT, STALE_TEMP_MS, UNKNOWN_HOST } from '../src/adapters.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, BOOT_SLACK_MS, MACHINE_ID_TIMEOUT_MS } from '../src/machine-id.js'
import { LOCK_GRACE_MS } from '../src/engine.js'
import { UPDATE_ATTEMPTS } from '../src/storage.js'
import type { GroupInputs, GroupName } from './inputs.js'
import { GROUPS, type Group } from './replay.js'
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
import { referencedLinks, trialReportDue } from './vectors/later.js'
import { grants, keyIds, keySets } from './vectors/keys.js'
import { filesAsLeases, licenseFileContainers, licenseFiles } from './vectors/files.js'

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
  referencedLinks,
  trialReportDue,
  keyIds,
  keySets,
  grants,
  licenseFileContainers,
  licenseFiles,
  filesAsLeases,
}

const COMMENT =
  'Generated from the KeyGrant Electron SDK (the reference). Every KeyGrant SDK must reproduce every answer: "expect", and also "verify", "claim", "fingerprint", "kids", "status" and "trial". Signed with TEST-ONLY keys. Do not edit; regenerate.'

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
  "referencedLinks: link with reference as its one client_reference_id, as upgradeUrl answers it with the stored activation id. The link is read as an absolute URL (every link here is already in its normal form), and its query is edited as text: each parameter named exactly client_reference_id (the text before its first =, or all of it) and each empty one left out, the others kept as written and in order, client_reference_id=<reference> added last (a reference needs no escaping), the fragment kept.",
  'trialReportDue takes a stored state and judges it at now (the guarded clock).',
  'merges.latest may hold purchaseToken, purchaseTokenAt and claimAskedAt, which an earlier version stored to buy from the app: every save leaves them out, whatever its basis.',
  'publicJwk is the key set of one every group but keySets verifies with: a lease naming no key (kid) is verified by it, one naming its id too, and one naming another id is unknown-key.',
  'keyIds.expect is the id a lease names a key by: the base64url (no padding) of the SHA-256 of {"crv":"Ed25519","kty":"OKP","x":"<x>"}, its RFC 7638 thumbprint, or null for a JWK every SDK refuses: one that is not an object, whose kty is not OKP or crv not Ed25519 (both required), that holds d, whose use (when given) is not sig, whose key_ops (when given) are not a list naming verify, whose alg (when given) is neither EdDSA nor Ed25519, or whose x, its trailing = dropped, is not canonical base64url of 32 bytes. No other member is read. keySets.kids are the ids of keys, in the order given, a key given twice kept once; keySets.verify is the lease verified against that set at now, as leases.verify.',
  "grants.expect: whether ent, read as a lease's ent is read, grants code: a flag that is true, a number that is not 0, a text that is not empty; the code matched exactly.",
  "licenseFileContainers.bytes is a file's content as canonical base64url (no padding); expect is the token it holds (licenseFileToken), or null when it is no licence file's container.",
  "licenseFiles: token verified against the key set keys (verifyLicenseFile; keys read as keySets.keys are), judged for product, the build's major and the denylist revoked (checkLicenseFile: expect is {ok, kind, test} or {ok, reason}); status is the status it gives when stored (licenseFileStatus). verify.claims are the claims as parsed: an offline file's ent read leniently, a key file's versions and entitlements not read.",
  "filesAsLeases: a licence file given where a lease goes, verified against publicJwk and judged as leases judges a lease (holder: this licence's key and activation, on a run that cannot tell its device), and as a trial lease for the same device (trial: trialLeaseValid).",
]

export async function generate() {
  const verifying = await importVerifyingKeys([TEST_PUBLIC_JWK as JsonWebKey])
  const ctx = await context()
  const groups: Record<string, unknown[]> = {}
  for (const group of Object.keys(GROUPS) as GroupName[]) {
    groups[group] = await answered(group, GROUPS[group], await BUILDERS[group](ctx), verifying)
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
      TRIAL_REPORT_MS,
      MAX_LICENSE_FILE_BYTES,
    },
    ...groups,
  }
}

/**
 * A group's vectors: each input with the reference's answers, computed from
 * exactly what the file will carry, or the generator stops: an answer is never
 * computed from anything JSON cannot say.
 */
async function answered(
  group: string,
  spec: Group<Record<string, unknown>>,
  inputs: readonly object[],
  key: readonly VerifyingKey[],
): Promise<unknown[]> {
  if (inputs.length === 0) throw new Error(`the group ${group} has no vectors`)
  const vectors: unknown[] = []
  for (const input of inputs) {
    const carried = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    deepStrictEqual(carried, input, `${group}: an input does not survive JSON`)
    vectors.push({ ...carried, ...(await spec.answer(carried, key)) })
  }
  return vectors
}

export const VECTORS_PATH = fileURLToPath(new URL('../../conformance/vectors.json', import.meta.url))

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(await generate(), null, 2)}\n`)
  console.log(`wrote ${VECTORS_PATH}`)
}
