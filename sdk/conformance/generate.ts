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
import { importVerifyingKeys, MAX_LICENSE_FILE_BYTES, MAX_METER_USES, OPEN_MAJOR, type VerifyingKey } from '@keygrant/shared'
import { ASK_AGAIN_MS, RENEW_WITHIN_MS, RETRY_UNANSWERED_MS, TRIAL_REPORT_MS } from '../src/offline.js'
import { CLOCK_TOLERANCE_MS } from '../src/clock.js'
import { MAX_DEVICE_NAME, MAX_KEY, STATUS_CHECK_TIMEOUT_MS } from '../src/wire.js'
import { DEFAULT_HTTP_TIMEOUT_MS, KEEP_CORRUPT, STALE_TEMP_MS, UNKNOWN_HOST } from '../src/adapters.js'
import { ACTIVATE_MACHINE_ID_TIMEOUT_MS, BOOT_SLACK_MS, MACHINE_ID_TIMEOUT_MS } from '../src/machine-id.js'
import { LOCK_GRACE_MS } from '../src/engine.js'
import { UPDATE_ATTEMPTS } from '../src/storage.js'
import { MAX_PENDING_SPENDS, MAX_PENDING_VOIDS, PENDING_MAX_MS, USE_TIMEOUT_MS } from '../src/meters.js'
import type { GroupInputs, GroupName } from './inputs.js'
import { GROUPS, type Group } from './replay.js'
import { meterClaims, meterFigures, meterLeases, meterStatuses, offlineSpends, useAmounts } from './vectors/meters.js'
import { syncAsks, useAsks } from './vectors/meter-asks.js'
import { spendConfirmations, spendReports, useOutcomes } from './vectors/meter-answers.js'
import { journals } from './vectors/meter-journal.js'
import { wireBodies } from './bodies.js'
import { typedFor, userLockErrors } from './vectors/user-lock.js'
import { pickedKeys, pickupAsks, pickupChoices, pickupRefusals } from './vectors/pickup.js'
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
  typedFor,
  userLockErrors,
  meterClaims,
  meterLeases,
  useAmounts,
  meterFigures,
  meterStatuses,
  offlineSpends,
  useAsks,
  syncAsks,
  useOutcomes,
  journals,
  spendReports,
  spendConfirmations,
  pickupAsks,
  pickupRefusals,
  pickedKeys,
  pickupChoices,
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
  'typedFor: email and code are what a person typed for a user-locked key, null when they gave none. expect is {send: {email?, code?}}, each member only when there was one to send, or {refused: error}, the error activate answers at once, before anything is asked of the server.',
  'The address is trimmed (as a key is: the whitespace a paste carries, a byte-order mark included) and sent as typed otherwise; a blank is none. One longer than 254 UTF-16 units after the trim (an astral character is two) is refused user-email-mismatch. The code has its ends trimmed and then its spaces (U+0020) dropped, and a blank is none; what remains must be exactly six ASCII digits (0 to 9), else it is refused user-code-invalid. The address is judged before the code.',
  'userLockErrors: error is the error word of a refused activation, as the server writes it (null or a number for a body that has none); expect is the error activate answers, every word of a user lock as itself and any other word as network.',
  'meterClaims: json is the JSON text of a lease\'s met claim (null: the lease has none), read by a JSON reader that reads every number as a double (-0 is 0; 1e400, out of a double\'s range, is infinity and no whole number); expect is the meters as read (metersOf): each member of an object whose left, total and offline are each a non-negative whole number of at most 2^53 - 1, with resets true only for JSON true; every other member is dropped, and anything that is not an object reads as none. Names are kept as they are, __proto__ included. The server\'s caps are not enforced.',
  'meterLeases: as leases. verify.claims carries met only when the lease has the claim, as read by metersOf (an empty object for one that is not an object).',
  'useAmounts: meter and n as the app gave them; a vector with no n is a call that gave none. expect is {meter, n} or {refused: invalid-amount | no-meter}, the answer use() gives at once, asking nothing. The amount is judged before the code. jsOnly: an n no typed port\'s call can hold (a fraction, a text), skipped by every typed port. A code is counted in UTF-16 units.',
  'meterFigures: met is the lease\'s met as read, iat its signing time in seconds, figures the stored meterFigures. expect is the base figures of each meter: its stored figure when that figure\'s at is at or after iat x 1000, else the lease\'s, else none.',
  'meterStatuses: figures are base figures and spends the journal; expect is status().meters: for each meter with a figure, left net of the unsynced spends (the n of its offline and unanswered entries, never a void) and never below 0.',
  'offlineSpends: expect is {ok: true, left, limit}, {ok: false, error: no-meter} or {ok: false, error: offline-limit, left}: allowed when the unsynced spends with n are at most the allowance and n is at most what is left; limit is the most the meter\'s unsynced spends may come to with the spend (the smaller of the allowance and what is left), which the journal judges again where the spend lands.',
  'useAsks: state holds the stored wait (backoffSince, backoffMs) and journal (spends); clockNow is the device clock, which the wait of a request that got no answer is judged by, and now the guarded clock, which the journal\'s wait is judged by. covered is whether the offline allowance would cover the spend (offlineSpends allows it): a spend it refuses always asks, whatever the waits. An unanswered or void entry opened after now is no wait that can be measured, and is left out of the journal\'s wait, of its count and of its newest. A spend the allowance refuses still waits for one wait of its own: a void opened less than RETRY_UNANSWERED_MS before now, none ahead of now counted. expect is whether use() asks the server.',
  'syncAsks: as validLeaseAsks, with a journal in the state: a valid lease asks also when the journal holds an entry while its wait is not running.',
  'useOutcomes: response is the answer to a use request (null when there was none at all); askedAt is the device clock when it was asked. expect is {outcome: spent | used-up | no-meter | refused | unanswered, refusal?, left?, patch, figures, confirmed}: patch what is saved as the answer to the ask (null clears a field), figures the figures saved (code to {left, total, offline, resets, at}), confirmed the reports the answer names as recorded.',
  'journals: op is one change to the journal about the activation it names (about); expect is the journal and the figures after it, as {spends, meterFigures, refused}: refused is true for a spend the full journal could not take (64 entries), or that would take its meter\'s unsynced spends (the n of its offline and unanswered entries) past the op\'s limit. A void that finds MAX_PENDING_VOIDS voids already held (in the constants) takes the place of the oldest, and is not refused for it. An op with told, a spend the customer was told was made while a failed save kept it in memory, lands whatever the limit and the cap say. An empty journal is spends [] and no figures is {}.',
  'spendReports: expect is the report a body carries for the journal, oldest first with a void marked, at most 64 entries, or null for none.',
  'spendConfirmations: expect is the reports an answer names as recorded, in order, read leniently: a member of another shape is left out. No answer at all, a 5xx and a 429 name none.',
  'pickupAsks: email and code are what a person typed for pickUp; code null is pickUp(email), the ask for a code, and a code (a blank one included) is pickUp(email, code), a confirm. expect is {send: {email, code?}} or {refused: error}, the error the call answers at once. The address is entered as typedFor enters it: trimmed, a blank one invalid-email, as is one longer than 254 UTF-16 units after the trim. The code is entered as typedFor enters it, and a blank one or one that is not six ASCII digits is wrong-code. The address is judged first.',
  'pickupRefusals: json is the body of a pickup call answered with anything but a 200 (null for none). expect is {error, retryAfter?}: pickup-disabled, wrong-code, code-expired, too-many-attempts and try-again as themselves, rate-limited as too-many-attempts, unavailable as try-again, invalid-request as invalid-email, and anything else (another word, a word not text, no body, a body not an object) as network. retryAfter is kept only on too-many-attempts and try-again, and only as a whole number from 0 to 2^53 - 1.',
  'pickedKeys: json is the body of a confirm answered 200. expect is null when it is no pickup answer (not an object, or keys not an array), which pickUp answers as network; else the keys in order, a member left out unless it is an object whose key is text of 1 to MAX_KEY UTF-16 units. Each kept member: model and state texts (else empty), modelName a text or null, entitlements read as a lease ent is, expiresAt, deviceLimit and activeDevices whole numbers from 0 (else null, 0 and 0), versions null unless an object with a whole minMajor from 0 (then maxMajor and upgradeUntil each whole from 0, else null), held true only for JSON true, sale only with a text id and whole index and size of at least 1, activationCode only as exactly six ASCII digits; userLock and every other member are not read.',
  'pickupChoices: keys are picked keys as read, major the build major (as majors gives it) and now the device clock in ms. expect is {index} of the key restoreByEmail activates, or {refused}. A key covers the build when its versions are null, or when minMajor <= major and (maxMajor is null, or major <= maxMajor, or upgradeUntil is after now). Of the keys that cover it: the first held, else the first with activeDevices < deviceLimit, else the first. No keys at all is no-key; keys none of which covers the build are upgrade when one has versions with minMajor <= major, else outdated.',
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
      MAX_METER_USES,
      MAX_PENDING_SPENDS,
      MAX_PENDING_VOIDS,
      PENDING_MAX_MS,
      USE_TIMEOUT_MS,
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
/** The requests a License sends with a report of unsynced spends, captured (bodies.ts); the worker's suite parses them. */
export const WIRE_BODIES_PATH = fileURLToPath(new URL('./wire-bodies.json', import.meta.url))

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files: [string, unknown][] = [
    [VECTORS_PATH, await generate()],
    [WIRE_BODIES_PATH, await wireBodies()],
  ]
  for (const [path, vectors] of files) {
    writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`)
    console.log(`wrote ${path}`)
  }
}
