import { describe, it, expect } from 'vitest'
import type { LeaseClaims } from '@keygrant/shared'
import {
  ASK_AGAIN_MS,
  RENEW_WITHIN_MS,
  RETRY_UNANSWERED_MS,
  askDue,
  renewsEarly,
  LEASED,
  leaseStatus,
  merged,
  standingRefusal,
  superseded,
  trialLeaseOf,
  trialStatusOf,
  withoutVerdict,
  type LeaseCheck,
} from './offline.js'
import type { StoredState } from './types.js'

/**
 * Which stored refusal still stands for the build running now (offline.ts
 * `standingRefusal`): a key-level one for every build, a build-level one for
 * the build refused and any further the same way.
 */

describe('standingRefusal', () => {
  it.each<[string, StoredState, number, ReturnType<typeof standingRefusal>]>([
    ['no refusal', {}, 3, null],
    ['revoked, any build', { refused: 'revoked' }, 1, 'revoked'],
    ['revoked, whatever major is stored', { refused: 'revoked', refusedMajor: 4 }, 2, 'revoked'],
    ['upgrade, at the refused major', { refused: 'upgrade', refusedMajor: 4 }, 4, 'upgrade'],
    ['upgrade, above it', { refused: 'upgrade', refusedMajor: 4 }, 5, 'upgrade'],
    ['upgrade, below it', { refused: 'upgrade', refusedMajor: 4 }, 3, null],
    ['outdated, at the refused major', { refused: 'outdated', refusedMajor: 2 }, 2, 'outdated'],
    ['outdated, below it', { refused: 'outdated', refusedMajor: 2 }, 1, 'outdated'],
    ['outdated, above it', { refused: 'outdated', refusedMajor: 2 }, 3, null],
    ['upgrade stored with no major (legacy), any build', { refused: 'upgrade' }, 1, 'upgrade'],
    ['outdated stored with no major (legacy), any build', { refused: 'outdated' }, 9, 'outdated'],
  ])('%s', (_case, state, major, expected) => {
    expect(standingRefusal(state, major)).toBe(expected)
  })

  // A device refusal stands for the device it was given for (`refusedFor`, claim
  // hashes), and only on a run that can tell it is still that device.
  it.each<[string, StoredState, { ownClaim?: string; canTell: boolean }, ReturnType<typeof standingRefusal>]>([
    ['device, for this device', { refused: 'device', refusedFor: ['A'] }, { ownClaim: 'A', canTell: true }, 'device'],
    ['device, for another device', { refused: 'device', refusedFor: ['A'] }, { ownClaim: 'B', canTell: true }, null],
    ['device, on a run that cannot tell', { refused: 'device', refusedFor: ['A'] }, { canTell: false }, null],
    ['device with no refusedFor: stands for any device', { refused: 'device' }, { ownClaim: 'B', canTell: true }, 'device'],
  ])('%s', (_case, state, device, expected) => {
    expect(standingRefusal(state, 1, device)).toBe(expected)
  })
})

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Whole seconds, as a lease carries them. */
const ISSUED = 1_757_000_000

/** A lease's claims, issued at ISSUED and living `lifeMs`. */
function claims(lifeMs: number): LeaseClaims {
  return {
    iss: 'keygrant',
    sub: 'SLUICE-AAAA-BBBB-CCCC-DDDD',
    product: 'sluice',
    aid: 'act_1',
    model: 'perpetual',
    lim: 3,
    major: 1,
    ent: {},
    iat: ISSUED,
    exp: ISSUED + lifeMs / 1000,
  }
}

/** The moment `left` ms before the end of a lease living `lifeMs`. */
const leftOf = (lifeMs: number, left: number) => (ISSUED * 1000 + lifeMs) - left

describe('renewsEarly', () => {
  it.each<[string, number, number, boolean]>([
    ['30-day lease, exactly RENEW_WITHIN_MS left', 30 * DAY, RENEW_WITHIN_MS, false],
    ['30-day lease, RENEW_WITHIN_MS - 1 left', 30 * DAY, RENEW_WITHIN_MS - 1, true],
    ['7-day lease, exactly half its life left', 7 * DAY, 3.5 * DAY, false],
    ['7-day lease, half its life - 1 left', 7 * DAY, 3.5 * DAY - 1, true],
    ['1-hour lease, exactly 30 minutes left', HOUR, 30 * 60_000, false],
    ['1-hour lease, 30 minutes - 1 left', HOUR, 30 * 60_000 - 1, true],
  ])('%s', (_case, life, left, expected) => {
    expect(renewsEarly(claims(life), leftOf(life, left))).toBe(expected)
  })
})

describe('askDue', () => {
  const SINCE = 1_757_000_000_000
  it.each<[string, StoredState, number, boolean, boolean]>([
    ['forced, whatever the wait', { backoffSince: SINCE, backoffMs: ASK_AGAIN_MS }, SINCE, true, true],
    ['no ask has come back without a lease', {}, SINCE, false, true],
    ['the clock set back before the ask', { backoffSince: SINCE, backoffMs: ASK_AGAIN_MS }, SINCE - 1, false, true],
    ['unanswered, 1 ms short of the wait', { backoffSince: SINCE, backoffMs: RETRY_UNANSWERED_MS }, SINCE + RETRY_UNANSWERED_MS - 1, false, false],
    ['unanswered, at the wait', { backoffSince: SINCE, backoffMs: RETRY_UNANSWERED_MS }, SINCE + RETRY_UNANSWERED_MS, false, true],
    ['answered, 1 ms short of the wait', { backoffSince: SINCE, backoffMs: ASK_AGAIN_MS }, SINCE + ASK_AGAIN_MS - 1, false, false],
    ['answered, at the wait', { backoffSince: SINCE, backoffMs: ASK_AGAIN_MS }, SINCE + ASK_AGAIN_MS, false, true],
    ['no wait stored (round-37 state), 1 ms short of the hour', { backoffSince: SINCE }, SINCE + ASK_AGAIN_MS - 1, false, false],
    ['no wait stored (round-37 state), at the hour', { backoffSince: SINCE }, SINCE + ASK_AGAIN_MS, false, true],
  ])('%s', (_case, state, clockNow, force, expected) => {
    expect(askDue(state, clockNow, force)).toBe(expected)
  })
})

describe("superseded: an ask's answer out of date by the time it is saved", () => {
  const asked = { at: 1_000, activationId: 'act_1', seen: 500 }
  it.each([
    ['the answer it saw is still the one stored', { activationId: 'act_1', verdictAt: 500 }, null],
    ['another answer saved since, asked for later (another process)', { activationId: 'act_1', verdictAt: 2_000 }, 'answer'],
    ['another answer saved since, asked for earlier', { activationId: 'act_1', verdictAt: 800 }, null],
    ['another answer saved since, asked for at the same moment', { activationId: 'act_1', verdictAt: 1_000 }, null],
    ['another activation stored since (activated again)', { activationId: 'act_2', verdictAt: 500 }, 'activation'],
    ['no activation stored since (deactivated)', { verdictAt: 500 }, 'activation'],
  ] as const)('%s: %s', (_case, latest, expected) => {
    expect(superseded(latest, asked)).toBe(expected)
  })

  it("saves one process's own answer over the one it saw, even stamped later than it (a clock put back)", () => {
    expect(superseded({ activationId: 'act_1', verdictAt: 2_000 }, { at: 1_000, activationId: 'act_1', seen: 2_000 })).toBeNull()
  })

  it('compares no times for an ask that saw no answer when none has been stored since', () => {
    expect(superseded({ activationId: 'act_1' }, { at: 1_000, activationId: 'act_1' })).toBeNull()
    expect(superseded({ activationId: 'act_1', verdictAt: 2_000 }, { at: 1_000, activationId: 'act_1' })).toBe('answer')
  })

  it('leaves out what the server said and the wait, and keeps what the device knows', () => {
    const patch = {
      lease: 'L',
      refused: 'revoked' as const,
      refusedMajor: 2,
      refusedFor: ['c'],
      backoffSince: 1,
      backoffMs: 2,
      checkedMajor: 3,
      verdictAt: 4,
      keptMajor: 5,
      deviceKind: 'machine' as const,
    }
    expect(withoutVerdict(patch)).toEqual({ keptMajor: 5, deviceKind: 'machine' })
  })
})

describe('merged: a save onto the state as stored now', () => {
  const answer = {
    lease: 'LA',
    checkedMajor: 3,
    keptMajor: 3,
    deviceKind: 'machine' as const,
    trialStart: 100,
    trialEndsAt: 900,
    trialLease: 'T',
  }
  const asked = { at: 1_000, activationId: 'act_1', seen: 500 }

  it.each([
    ['deactivated meanwhile', { trialStart: 200 }],
    ['another key activated meanwhile', { key: 'B', activationId: 'act_2', lease: 'LB', deviceKind: 'hostname' as const, trialStart: 200 }],
  ])('keeps only the trial evidence of an answer about an activation %s', (_case, latest) => {
    const saved = merged(latest, answer, { answer: asked })
    expect(saved).toEqual({ ...latest, trialStart: 100, trialEndsAt: 900, trialLease: 'T' })
  })

  it('keeps only the trial evidence of a note about an activation no longer stored', () => {
    expect(merged({ activationId: 'act_2' }, { keptMajor: 3 }, { about: { activationId: 'act_1' } })).toEqual({ activationId: 'act_2' })
    expect(merged({ activationId: 'act_1' }, { keptMajor: 3 }, { about: { activationId: 'act_1' } })).toEqual({
      activationId: 'act_1',
      keptMajor: 3,
    })
    // None stored at all (deactivated): nothing of it either.
    expect(merged({}, { keptMajor: 3 }, { about: { activationId: 'act_1' } })).toEqual({})
  })

  it('keeps the verdict of a newer answer about the same activation, and saves the rest of an older one', () => {
    const latest = { activationId: 'act_1', refused: 'revoked' as const, verdictAt: 2_000 }
    expect(merged(latest, answer, { answer: asked })).toEqual({
      activationId: 'act_1',
      refused: 'revoked',
      verdictAt: 2_000,
      keptMajor: 3,
      deviceKind: 'machine',
      trialStart: 100,
      trialEndsAt: 900,
      trialLease: 'T',
    })
  })

  describe("an activation's answer", () => {
    const activated = { key: 'K', activationId: 'act_1', lease: 'LA', checkedMajor: 2, ...LEASED, deviceKind: 'machine' as const }
    const refusedLater = { key: 'K', activationId: 'act_1', refused: 'revoked' as const, verdictAt: 2_000 }

    it('on the same seat, under a refusal asked for later: the key and kind land, not the lease', () => {
      const saved = merged(refusedLater, activated, { activation: { at: 1_000, activationId: 'act_1', seen: 500 } })
      expect(saved).toEqual({ key: 'K', activationId: 'act_1', refused: 'revoked', verdictAt: 2_000, deviceKind: 'machine' })
    })

    it('on the same seat, over the verdict it saw: lands whole', () => {
      const saved = merged(refusedLater, activated, { activation: { at: 1_000, activationId: 'act_1', seen: 2_000 } })
      expect(saved).toMatchObject({ lease: 'LA', checkedMajor: 2, verdictAt: 1_000 })
      expect(saved.refused).toBeUndefined()
    })

    it('of another activation: lands whole, whatever was stored', () => {
      const saved = merged(refusedLater, { ...activated, activationId: 'act_2' }, { activation: { at: 1_000, activationId: 'act_2' } })
      expect(saved).toMatchObject({ activationId: 'act_2', lease: 'LA', verdictAt: 1_000 })
      expect(saved.refused).toBeUndefined()
    })
  })

  describe('the kept major', () => {
    const about = { about: { activationId: 'act_1' } }
    it.each([
      ['a lower one noted', 5, 3, about, 5],
      ['a higher one noted', 3, 5, about, 5],
      ['an answer that noted none', 5, undefined, { answer: { at: 1, activationId: 'act_1' } }, 5],
      ['a deactivation, based on nothing', 5, undefined, {}, undefined],
      ['a fresh activation', 5, undefined, { activation: { at: 1, activationId: 'act_2' } }, undefined],
      ['an activation of the same seat', 5, 3, { activation: { at: 1, activationId: 'act_1' } }, 5],
    ] as const)('only goes up for the stored activation: %s', (_case, stored, noted, basis, expected) => {
      const saved = merged({ activationId: 'act_1', keptMajor: stored }, { keptMajor: noted }, basis)
      expect(saved.keptMajor).toBe(expected)
    })
  })

  it('stamps an answer and a trial answer with when they were asked for', () => {
    expect(merged({ activationId: 'act_1' }, { lease: 'L' }, { answer: asked })).toMatchObject({ verdictAt: 1_000 })
    expect(merged({}, { trialEndsAt: 9 }, { trial: { at: 7 } })).toEqual({ trialEndsAt: 9, trialAt: 7 })
  })

  describe('a trial answer', () => {
    const stored = { trialStart: 50, trialEndsAt: 500, trialLease: 'NEWER', trialAt: 2_000 }
    it('loses its end and lease to a newer one stored since, whichever ends first', () => {
      for (const end of [400, 600]) {
        const saved = merged(stored, { trialStart: 60, trialEndsAt: end, trialLease: 'OLDER' }, { trial: { at: 1_000 } })
        expect(saved).toEqual(stored)
      }
    })

    it("wins over an older one, a later end included (a trial the server extended)", () => {
      const saved = merged(stored, { trialStart: 60, trialEndsAt: 900, trialLease: 'EXT' }, { trial: { at: 3_000 } })
      expect(saved).toEqual({ trialStart: 50, trialEndsAt: 900, trialLease: 'EXT', trialAt: 3_000 })
    })

    it("wins over a stored one with no stamp (an older SDK's)", () => {
      const saved = merged({ trialEndsAt: 500, trialLease: 'OLD' }, { trialEndsAt: 400, trialLease: 'NEW' }, { trial: { at: 1 } })
      expect(saved).toEqual({ trialEndsAt: 400, trialLease: 'NEW', trialAt: 1 })
    })

    it('wins over the one it saw, even stamped later than it (a clock put back)', () => {
      const saved = merged(stored, { trialEndsAt: 300, trialLease: 'MINE' }, { trial: { at: 1_000, seen: 2_000 } })
      expect(saved).toMatchObject({ trialEndsAt: 300, trialLease: 'MINE', trialAt: 1_000 })
    })
  })
})

/**
 * The status a lease gives offline, and the entitlements it carries
 * (`leaseStatus`, `trialLeaseOf`, `trialStatusOf`): only a lease that
 * licenses, or a trial lease that runs a trial, carries them, and only when
 * it grants any.
 */
describe('entitlements in a status', () => {
  const PRO = { edition: 'pro', seats: 5 }
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  const granting = { ...claims(30 * DAY), ent: PRO }

  it("licensed: with the lease's entitlements and its test flag", () => {
    expect(leaseStatus({ ok: true, test: false, claims: granting }, KEY)).toEqual({ state: 'licensed', key: KEY, entitlements: PRO })
    const test = { ...granting, test: true }
    expect(leaseStatus({ ok: true, test: true, claims: test }, KEY)).toEqual({ state: 'licensed', key: KEY, test: true, entitlements: PRO })
  })

  it('licensed by a lease that grants none: no member at all', () => {
    const status = leaseStatus({ ok: true, test: false, claims: claims(30 * DAY) }, KEY)
    expect(status).toEqual({ state: 'licensed', key: KEY })
    expect(Object.keys(status)).toEqual(['state', 'key'])
  })

  it.each<[LeaseCheck & { ok: false }, ReturnType<typeof leaseStatus>]>([
    [{ ok: false, reason: 'expired' }, { state: 'expired', reason: 'offline', key: KEY }],
    [{ ok: false, reason: 'upgrade' }, { state: 'invalid', reason: 'upgrade', key: KEY }],
    [{ ok: false, reason: 'outdated' }, { state: 'invalid', reason: 'outdated', key: KEY }],
    [{ ok: false, reason: 'device' }, { state: 'invalid', reason: 'device', key: KEY }],
    [{ ok: false, reason: 'tampered' }, { state: 'invalid', reason: 'tampered' }],
  ])('not licensed (%o): no entitlements', (check, expected) => {
    expect(leaseStatus(check, KEY)).toEqual(expected)
  })

  it("a status's entitlements are a frozen copy, not the claims' own object", () => {
    const { entitlements } = leaseStatus({ ok: true, test: false, claims: granting }, KEY)
    expect(entitlements).toEqual(PRO)
    expect(entitlements).not.toBe(granting.ent)
    expect(Object.isFrozen(entitlements)).toBe(true)
  })

  const device = { claims: ['claim-own'], canTell: true }
  const trial = { ...claims(7 * DAY), model: 'trial' as const, aid: 'claim-own', fpk: 'machine' as const, ent: PRO }

  it('a valid trial lease: its end and its entitlements', () => {
    expect(trialLeaseOf({ valid: true, claims: trial }, 'sluice', device)).toEqual({ valid: true, endsAt: trial.exp * 1000, entitlements: PRO })
  })

  it.each<[string, Parameters<typeof trialLeaseOf>[0], string, typeof device]>([
    ['expired', { valid: false, reason: 'expired', claims: trial }, 'sluice', device],
    ["another product's", { valid: true, claims: trial }, 'maindeck', device],
    ["another device's", { valid: true, claims: trial }, 'sluice', { claims: ['claim-other'], canTell: true }],
    ["a licence's", { valid: true, claims: { ...trial, model: 'perpetual' } }, 'sluice', device],
  ])('a trial lease that is %s: not valid, and nothing of its end or entitlements', (_case, verified, product, who) => {
    expect(trialLeaseOf(verified, product, who)).toEqual({ valid: false })
  })

  it("a running trial's entitlements are a frozen copy, not the object it was given", () => {
    const state: StoredState = { trialStart: ISSUED * 1000, trialLease: 'stored' }
    const given = { ...PRO }
    const { entitlements } = trialStatusOf(state, ISSUED * 1000, true, ISSUED * 1000 + DAY, given)
    expect(entitlements).toEqual(PRO)
    expect(entitlements).not.toBe(given)
    expect(Object.isFrozen(entitlements)).toBe(true)
  })

  it('a running trial carries the entitlements it is given; an ended one none', () => {
    const state: StoredState = { trialStart: ISSUED * 1000, trialLease: 'stored' }
    const now = ISSUED * 1000
    expect(trialStatusOf(state, now, true, now + 3 * DAY, PRO)).toEqual({ state: 'trial', trialEndsAt: now + 3 * DAY, trialDaysLeft: 3, entitlements: PRO })
    // No member at all, not one set to undefined, which toEqual would not tell apart.
    expect(Object.keys(trialStatusOf(state, now, true, now + 3 * DAY, {}))).toEqual(['state', 'trialEndsAt', 'trialDaysLeft'])
    expect(Object.keys(trialStatusOf(state, now, true, now + 3 * DAY))).toEqual(['state', 'trialEndsAt', 'trialDaysLeft'])
    expect(trialStatusOf(state, now, false, undefined, PRO)).toEqual({ state: 'expired', reason: 'trial' })
    expect(trialStatusOf({}, now, true, now + 3 * DAY, PRO)).toEqual({ state: 'unlicensed' })
  })
})
