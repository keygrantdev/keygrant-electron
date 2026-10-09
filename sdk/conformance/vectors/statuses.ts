/**
 * The status a stored lease gives, judged offline with no verdict from the server, and the
 * entitlements it carries: `leaseStatuses` for a licence lease (offline.ts `leaseStatus` of
 * `checkLease`), `trialLeaseStatuses` for a trial lease (`trialStatusOf` of `trialLeaseOf`, the
 * trial lease being the trial's only evidence). Only a lease that licenses, or a trial that runs,
 * carries its entitlements, and only when it grants any.
 */
import { keyId } from '@keygrant/shared'
import type { LeaseVector, TrialVector } from '../inputs.js'
import { DAY_MS, HEADER, NEXT_PRIVATE_JWK, NOW, NOW_S, OTHER_PRIVATE_JWK, claims, publicOf, sign, type Context } from './common.js'
import { MIXED_ENT, leaseVectors, type LeaseCase } from './leases.js'
import { trialClaims, trialVector } from './trials.js'

/** Malformed members beside good ones: only `edition` and `seats` are entitlements. */
const PARTLY_MALFORMED = { nested: { tier: 'gold' }, edition: 'pro', none: null, list: ['a'], seats: 2 }

/** An entitlement named `__proto__` (an own member, as JSON.parse makes it), which a status must carry like any other. */
const PROTO_ENT = JSON.parse('{"__proto__":"studio","seats":3}') as Record<string, unknown>

export async function leaseStatuses(ctx: Context): Promise<LeaseVector[]> {
  const another = { fp: ctx.strangerClaim, fpk: 'machine' }
  const cases: LeaseCase[] = [
    { name: 'a lease with no entitlements: licensed, with none', token: await sign(claims()) },
    { name: 'a lease with no ent claim: licensed, with none', token: await sign(claims({ ent: undefined })) },
    { name: 'a lease with entitlements of every kind: licensed, with them', token: await sign(claims({ ent: MIXED_ENT })) },
    { name: 'a test lease with entitlements: licensed, test, with them', token: await sign(claims({ ent: MIXED_ENT, test: true })) },
    { name: 'a test lease with no entitlements: licensed, test, with none', token: await sign(claims({ test: true })) },
    { name: 'malformed members beside good ones: licensed, with the good ones', token: await sign(claims({ ent: PARTLY_MALFORMED })) },
    { name: 'members all malformed: licensed, with none', token: await sign(claims({ ent: { nested: {}, none: null } })) },
    { name: 'entitlements that are a list: licensed, with none', token: await sign(claims({ ent: ['pro'] })) },
    { name: 'entitlements that are null: licensed, with none', token: await sign(claims({ ent: null })) },
    { name: 'entitlements that are a text: licensed, with none', token: await sign(claims({ ent: 'pro' })) },
    { name: 'an expired lease with entitlements: expired, with none', token: await sign(claims({ exp: NOW_S - 1, ent: MIXED_ENT })) },
    { name: 'a lease for another device, with entitlements: invalid, with none', token: await sign(claims({ ...another, ent: MIXED_ENT })) },
    { name: 'a build newer than covered, with entitlements: invalid, with none', token: await sign(claims({ ent: MIXED_ENT })), major: 4 },
    {
      name: 'a build older than covered, with entitlements: invalid, with none',
      token: await sign(claims({ ent: MIXED_ENT, minMajor: 2 })),
      major: 1,
    },
    {
      name: 'a lease for another key, with entitlements: invalid, tampered, with none',
      token: await sign(claims({ sub: 'SLUICE-ZZZZ-ZZZZ-ZZZZ-ZZZZ', ent: MIXED_ENT })),
    },
    {
      name: 'a lease signed by another key, with entitlements: invalid, tampered, with none',
      token: await sign(claims({ ent: MIXED_ENT }), HEADER, OTHER_PRIVATE_JWK),
    },
    // Later (a group only grows at its end): every other shape of ent, and a name a status must keep.
    { name: 'entitlements that are a number: licensed, with none', token: await sign(claims({ ent: 42 })) },
    { name: 'entitlements that are a flag: licensed, with none', token: await sign(claims({ ent: true })) },
    { name: 'an entitlement named __proto__: licensed, with it', token: await sign(claims({ ent: PROTO_ENT })) },
    {
      name: 'a lease signed by a key the build does not carry, with entitlements: invalid, unknown-key, with the key and none',
      token: await sign(claims({ ent: MIXED_ENT }), { ...HEADER, kid: await keyId(publicOf(NEXT_PRIVATE_JWK)) }, NEXT_PRIVATE_JWK),
    },
  ]
  return leaseVectors(cases, ctx)
}

/** When every stored trial of `trialLeaseStatuses` started: a day before NOW, as its lease was signed. */
const TRIAL_START = NOW - DAY_MS

export async function trialLeaseStatuses(ctx: Context): Promise<(TrialVector & { trialStart: number })[]> {
  const trial = (over: Record<string, unknown>) => sign(trialClaims(ctx, { fpk: 'machine', ...over }))
  const cases = [
    { name: 'a trial with entitlements of every kind: trial, with them', token: await trial({ ent: MIXED_ENT }), canTell: true },
    { name: 'a trial with no entitlements: trial, with none', token: await trial({}), canTell: true },
    { name: 'a trial with no ent claim: trial, with none', token: await trial({ ent: undefined }), canTell: true },
    { name: 'a trial with malformed members beside good ones: trial, with the good ones', token: await trial({ ent: PARTLY_MALFORMED }), canTell: true },
    { name: 'a trial whose entitlement members are all malformed: trial, with none', token: await trial({ ent: { nested: {}, none: null } }), canTell: true },
    { name: 'a trial whose entitlements are a list: trial, with none', token: await trial({ ent: ['pro'] }), canTell: true },
    { name: 'a trial whose entitlements are null: trial, with none', token: await trial({ ent: null }), canTell: true },
    {
      name: 'a trial for another device, on a run that cannot tell, with entitlements: trial, with them',
      token: await trial({ aid: ctx.strangerClaim, ent: MIXED_ENT }),
      canTell: false,
    },
    {
      name: 'a trial for another device, with entitlements: expired, with none',
      token: await trial({ aid: ctx.strangerClaim, ent: MIXED_ENT }),
      canTell: true,
    },
    { name: 'a trial past its end, with entitlements: expired, with none', token: await trial({ exp: NOW_S - 1, ent: MIXED_ENT }), canTell: true },
    {
      name: "a licence's lease in the trial's place, with entitlements: expired, with none",
      token: await sign(claims({ ent: MIXED_ENT })),
      canTell: true,
    },
    // Later (a group only grows at its end): every other shape of ent, and a name a status must keep.
    { name: 'a trial whose entitlements are a text: trial, with none', token: await trial({ ent: 'pro' }), canTell: true },
    { name: 'a trial whose entitlements are a number: trial, with none', token: await trial({ ent: 42 }), canTell: true },
    { name: 'a trial whose entitlements are a flag: trial, with none', token: await trial({ ent: true }), canTell: true },
    { name: 'a trial with an entitlement named __proto__: trial, with it', token: await trial({ ent: PROTO_ENT }), canTell: true },
  ]
  return cases.map((t) => ({ ...trialVector(ctx, t), trialStart: TRIAL_START }))
}
