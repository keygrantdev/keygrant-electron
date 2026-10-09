/** The `trials` group: a trial lease verified and judged for this product and device (offline.ts `trialLeaseValid`). */
import { OPEN_MAJOR } from '@keygrant/shared'
import type { TrialVector } from '../inputs.js'
import { DAY, NOW, NOW_S, PRODUCT, claims, clean, flipped, segments, sign, type Context } from './common.js'

/** A trial lease's claims for this device, valid by default; `over` changes or removes any of them. */
export function trialClaims(ctx: Context, over: Record<string, unknown> = {}): Record<string, unknown> {
  return clean({
    iss: 'keygrant',
    sub: `trial:${ctx.ownClaim}`,
    product: PRODUCT,
    aid: ctx.ownClaim,
    model: 'trial',
    lim: 1,
    major: OPEN_MAJOR,
    ent: {},
    iat: NOW_S - DAY,
    exp: NOW_S + 6 * DAY,
    ...over,
  })
}

/** A trial lease and whether this run can tell who the device is, as a vector (this product, now NOW, this device). */
export function trialVector(ctx: Context, t: { name: string; token: string; canTell: boolean }): TrialVector {
  return {
    name: t.name,
    token: t.token,
    now: NOW,
    product: PRODUCT,
    device: { claims: [ctx.ownClaim, ctx.altClaim], canTell: t.canTell },
  }
}

export async function trials(ctx: Context): Promise<TrialVector[]> {
  const { altClaim, strangerClaim } = ctx
  const claimsFor = (over: Record<string, unknown> = {}) => trialClaims(ctx, over)
  const goodTrial = await sign(claimsFor({ fpk: 'machine' }))
  const [tHeader, tPayload, tSig] = segments(goodTrial)
  const another = await sign(claimsFor({ fpk: 'machine', aid: strangerClaim }))
  const cases = [
    { name: 'a trial for this device', token: goodTrial, canTell: true },
    { name: 'a trial for another device', token: another, canTell: true },
    { name: 'a trial for another device, on a run that cannot tell', token: another, canTell: false },
    { name: 'a host-name trial for another device', token: await sign(claimsFor({ fpk: 'hostname', aid: strangerClaim })), canTell: true },
    { name: 'a trial of no kind for another device', token: await sign(claimsFor({ aid: strangerClaim })), canTell: true },
    { name: "a trial for this device's alternate", token: await sign(claimsFor({ fpk: 'machine', aid: altClaim })), canTell: true },
    { name: 'a trial for another product', token: await sign(claimsFor({ fpk: 'machine', product: 'maindeck' })), canTell: true },
    { name: 'a trial past its end', token: await sign(claimsFor({ fpk: 'machine', exp: NOW_S - 1 })), canTell: true },
    { name: 'a trial whose signature was changed', token: `${tHeader}.${tPayload}.${flipped(tSig, 10, 0x80)}`, canTell: true },
    { name: "a licence's lease in the trial's place", token: await sign(claims()), canTell: true },
  ]
  return cases.map((t) => trialVector(ctx, t))
}
