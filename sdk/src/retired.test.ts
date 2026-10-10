import { describe, it, expect } from 'vitest'
import { launchReportSettled } from './trials.js'
import type { StoredState } from './types.js'
import { DAY, NOW, harness } from './license.fixture.js'

/**
 * What an earlier version stored to buy from the app with no key typed: a
 * purchase secret and the two stamps beside it. This version never sends it
 * and never keeps it: the next save leaves it out (merge.ts RETIRED_FIELDS).
 */
const RETIRED = { purchaseToken: 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c', purchaseTokenAt: NOW - DAY, claimAskedAt: NOW - 60_000 }

describe('a purchase secret an earlier version stored', () => {
  it('is never sent, by status(), refresh() or startTrial(), and the first save leaves it out', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease, lastSeen: NOW, ...RETIRED } as StoredState)
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    expect((await h.license.status()).state).toBe('trial')
    await launchReportSettled(h.license)
    // The launch report's stamp is the first save, and it carries none of them.
    const stored = h.getStored() ?? {}
    expect(stored).toMatchObject({ trialReportedAt: NOW })
    for (const field of Object.keys(RETIRED)) expect(field in stored, field).toBe(false)
    await h.license.refresh()
    await h.license.startTrial()
    expect(h.http.called('claim')).toBe(false)
    for (const call of h.http.calls) expect(JSON.stringify(call.body)).not.toContain(RETIRED.purchaseToken)
  })

  it('is left out by an activation, and a later deactivation activates nothing', async () => {
    const h = await harness()
    h.setStored({ lastSeen: NOW, ...RETIRED } as StoredState)
    const lease = await h.sign('KEY-1', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('deactivate', () => ({ status: 200, json: { released: true } }))
    expect(await h.license.activate('KEY-1')).toEqual({ ok: true })
    for (const field of Object.keys(RETIRED)) expect(field in (h.getStored() ?? {}), field).toBe(false)
    expect(await h.license.deactivate()).toEqual({ released: true })
    expect(await h.license.status()).toEqual({ state: 'unlicensed' })
    expect(h.http.calls.map((c) => c.action)).toEqual(['activate', 'deactivate'])
  })
})
