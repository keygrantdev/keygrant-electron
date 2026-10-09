/** The `merges` group: what of a save lands on a state another process saved meanwhile (offline.ts `merged`). */
import { ASK_AGAIN_MS, LEASED, NO_PURCHASE, UNKEYED, type Basis } from '../../src/offline.js'
import type { StoredState } from '../../src/types.js'
import type { GroupInputs } from '../inputs.js'
import { encodePatch } from '../replay.js'
import { AID, DAY_MS, KEY, NOW, clean, type Context } from './common.js'
import { TOKEN } from './purchases.js'

interface MergeCase {
  name: string
  latest: StoredState
  patch: Partial<StoredState>
  basis?: Basis
}

/** The state another process saved: a lease, a kept major, a trial and its answer, install memory. */
const LATEST: StoredState = {
  key: KEY,
  activationId: AID,
  lease: 'lease-latest',
  verdictAt: NOW - 1000,
  keptMajor: 3,
  trialStart: NOW - 10 * DAY_MS,
  trialEndsAt: NOW + DAY_MS,
  trialAt: NOW - 5000,
  lastSeen: NOW,
  deviceKind: 'machine',
}

/** An ask about the stored activation, asked now, by a process that saw the stored verdict. */
const CURRENT: Basis = { answer: { at: NOW, activationId: AID, seen: NOW - 1000 } }

export function merges(ctx: Context): GroupInputs['merges'][] {
  const cases = [...answers(), ...trialsAndSeats(ctx), ...reactivations(), ...purchases()]
  return cases.map((m) => ({ name: m.name, latest: clean(m.latest), patch: encodePatch(m.patch), basis: m.basis ?? null }))
}

/** Answers to asks, and notes, about this activation or another. */
function answers(): MergeCase[] {
  const latest = LATEST
  return [
    { name: 'an unbased patch lands whole', latest, patch: { checkedMajor: 2 } },
    { name: 'an answer to an ask, current', latest, patch: { lease: 'lease-new', checkedMajor: 2 }, basis: CURRENT },
    {
      name: 'an older answer than the stored one loses its verdict',
      latest,
      patch: { lease: 'lease-old', checkedMajor: 2, deviceKind: 'hostname' },
      basis: { answer: { at: NOW - 2000, activationId: AID, seen: NOW - 3000 } },
    },
    {
      name: 'an answer asked at the very moment of the stored one still lands',
      latest,
      patch: { lease: 'lease-same-moment' },
      basis: { answer: { at: NOW - 1000, activationId: AID, seen: NOW - 3000 } },
    },
    {
      name: "this process's own answer lands though the clock was put back",
      latest,
      patch: { lease: 'lease-own', refused: undefined },
      basis: { answer: { at: NOW - 50_000, activationId: AID, seen: NOW - 1000 } },
    },
    {
      name: 'an answer about another activation keeps only trial evidence',
      latest,
      patch: { lease: 'lease-other', trialStart: NOW - 20 * DAY_MS, keptMajor: 9 },
      basis: { answer: { at: NOW, activationId: 'act_old', seen: NOW - 1000 } },
    },
    {
      name: 'a note about another activation keeps only trial evidence',
      latest,
      patch: { keptMajor: 9, deviceKind: 'hostname', trialEndsAt: NOW + 2 * DAY_MS },
      basis: { about: { activationId: 'act_old' } },
    },
    { name: 'the trial start only moves earlier', latest, patch: { trialStart: NOW - DAY_MS } },
    { name: 'an earlier trial start lands', latest, patch: { trialStart: NOW - 30 * DAY_MS } },
    { name: 'a kept major only goes up for the stored activation', latest, patch: { keptMajor: 2 }, basis: { about: { activationId: AID } } },
    { name: 'a higher kept major lands', latest, patch: { keptMajor: 5 }, basis: { about: { activationId: AID } } },
    { name: 'a renewal with no kept major keeps the stored one', latest, patch: { lease: 'lease-r', keptMajor: undefined }, basis: CURRENT },
    { name: 'an unbased patch (a deactivation) sets the kept major as given', latest, patch: { keptMajor: 1 } },
  ]
}

/** Trial answers, activations, a deactivation and a new lease. */
function trialsAndSeats(ctx: Context): MergeCase[] {
  const latest = LATEST
  const untried: StoredState = { key: KEY, activationId: AID, lease: 'lease-latest', verdictAt: NOW - 1000, lastSeen: NOW }
  return [
    {
      name: 'an older trial answer loses its end and lease',
      latest,
      patch: { trialEndsAt: NOW + 9 * DAY_MS, trialLease: 'trial-old' },
      basis: { trial: { at: NOW - 9000, seen: NOW - 10_000 } },
    },
    {
      name: 'a newer trial answer replaces the end and lease',
      latest,
      patch: { trialEndsAt: NOW + 9 * DAY_MS, trialLease: 'trial-new' },
      basis: { trial: { at: NOW, seen: NOW - 5000 } },
    },
    {
      name: 'a trial answer onto a state with no trial answer lands',
      latest: untried,
      patch: { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 6 * DAY_MS, trialLease: 'trial-first' },
      basis: { trial: { at: NOW - 100, seen: NOW - 500 } },
    },
    {
      name: 'an activation replaces another activation whole',
      latest,
      patch: { key: 'SLUICE-NEW1-NEW1-NEW1-NEW1', activationId: 'act_new', lease: 'lease-act', keptMajor: undefined, deviceKind: undefined },
      basis: { activation: { at: NOW, activationId: 'act_new', seen: NOW - 1000 } },
    },
    {
      name: 'the same seat activated again, older than the stored verdict, loses its verdict',
      latest: { ...latest, refused: 'revoked', lease: undefined },
      patch: { key: KEY, activationId: AID, lease: 'lease-reactivated', refused: undefined, deviceKind: 'machine' },
      basis: { activation: { at: NOW - 5000, activationId: AID, seen: NOW - 6000 } },
    },
    {
      name: 'a deactivation clears all but trial evidence and the clock guard',
      latest: { ...latest, refused: 'device', refusedFor: [ctx.ownClaim], backoffSince: NOW - 10, backoffMs: ASK_AGAIN_MS, checkedMajor: 2 },
      patch: { ...UNKEYED, verdictAt: NOW },
    },
    {
      name: 'a new lease clears the refusal and the wait',
      latest: { ...latest, refused: 'upgrade', refusedMajor: 4, backoffSince: NOW - 10, backoffMs: ASK_AGAIN_MS },
      patch: { lease: 'lease-healed', checkedMajor: 4, ...LEASED },
      basis: CURRENT,
    },
  ]
}

/** The same seat activated again, newer than the stored verdict: an answer like any, so it lands whole. */
function reactivations(): MergeCase[] {
  return [
    {
      name: 'the same seat activated again, newer than the stored verdict, lands whole',
      latest: { ...LATEST, refused: 'revoked', lease: undefined },
      patch: { key: KEY, activationId: AID, lease: 'lease-reactivated', refused: undefined, deviceKind: 'machine' },
      basis: { activation: { at: NOW, activationId: AID, seen: NOW - 1000 } },
    },
  ]
}

/** The token another process made meanwhile (`purchases`). */
const OTHER_TOKEN = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

/**
 * The purchase token and its stamps: a link's save, a drop and a wait saved
 * about their token (basis `purchase`), what an activation and a deactivation
 * clear of them (NO_PURCHASE), and the launch report's stamp.
 */
function purchases(): MergeCase[] {
  const trial: StoredState = { trialStart: NOW - 3 * DAY_MS, trialEndsAt: NOW + 4 * DAY_MS, trialAt: NOW - 5000, lastSeen: NOW }
  const holding: StoredState = { ...trial, purchaseToken: TOKEN, purchaseTokenAt: NOW - DAY_MS, claimAskedAt: NOW - 60_000 }
  const replaced: StoredState = { ...holding, purchaseToken: OTHER_TOKEN, purchaseTokenAt: NOW - 1000 }
  const about: Basis = { purchase: { token: TOKEN } }
  // The wait after a claim: about the secret as its link was handed out when the claim was asked.
  const waited: Basis = { purchase: { token: TOKEN, at: NOW - DAY_MS } }
  const activated = { key: 'SLUICE-BUY1-BUY1-BUY1-BUY1', activationId: 'act_new', lease: 'lease-bought', checkedMajor: 3, ...LEASED, deviceKind: 'machine' as const }
  return [
    { name: "a purchase link's save lands whole", latest: trial, patch: { purchaseToken: TOKEN, purchaseTokenAt: NOW, claimAskedAt: undefined } },
    { name: 'a drop about the token stored clears it', latest: holding, patch: NO_PURCHASE, basis: about },
    { name: 'the wait after a claim about the token stored lands', latest: holding, patch: { claimAskedAt: NOW }, basis: waited },
    { name: 'a drop about a token no longer stored leaves the new one', latest: replaced, patch: NO_PURCHASE, basis: about },
    { name: 'the wait after a claim about a token no longer stored is not saved', latest: replaced, patch: { claimAskedAt: NOW }, basis: waited },
    { name: 'a drop about a token an activation cleared meanwhile changes nothing', latest: LATEST, patch: NO_PURCHASE, basis: about },
    {
      name: "a bought key's activation clears the purchase fields",
      latest: holding,
      patch: { ...activated, ...NO_PURCHASE },
      basis: { activation: { at: NOW, activationId: 'act_new' } },
    },
    {
      name: 'an activation of the same seat older than the stored verdict still clears the purchase fields',
      latest: { ...LATEST, purchaseToken: TOKEN, purchaseTokenAt: NOW - DAY_MS },
      patch: { key: KEY, activationId: AID, lease: 'lease-reactivated', ...NO_PURCHASE },
      basis: { activation: { at: NOW - 5000, activationId: AID, seen: NOW - 6000 } },
    },
    {
      name: 'a deactivation clears the purchase fields',
      latest: { ...LATEST, purchaseToken: TOKEN, purchaseTokenAt: NOW - DAY_MS, claimAskedAt: NOW - 1000 },
      patch: { ...UNKEYED, ...NO_PURCHASE, verdictAt: NOW },
    },
    { name: "a launch report's stamp lands", latest: holding, patch: { trialReportedAt: NOW } },
    {
      name: "the wait after a claim, the same secret's link handed out again since, is not saved",
      latest: { ...holding, purchaseTokenAt: NOW - 1000, claimAskedAt: undefined },
      patch: { claimAskedAt: NOW },
      basis: waited,
    },
    {
      name: "a drop, the same secret's link handed out again since, still lands",
      latest: { ...holding, purchaseTokenAt: NOW - 1000, claimAskedAt: undefined },
      patch: NO_PURCHASE,
      basis: about,
    },
  ]
}
