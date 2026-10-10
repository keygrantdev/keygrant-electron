import { describe, it, expect, vi, afterEach } from 'vitest'
import { STATUS_CHECK_TIMEOUT_MS } from './wire.js'
import { TRIAL_REPORT_MS } from './offline.js'
import { launchReportSettled } from './trials.js'
import type { Fingerprinter, StoredState } from './types.js'
import { DAY, NOW, harness, type Harness } from './license.fixture.js'

const TRIAL_STATUS = { state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5 }

/** A running trial (its lease valid), with `over` on top: no trial answer or report stamped unless given. */
async function running(h: Harness, over: StoredState = {}): Promise<StoredState> {
  const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
  return { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease, lastSeen: NOW, ...over }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a running trial reports its launch', () => {
  it('from status(), stamped first, then POSTed in the background as startTrial() would, its answer not read', async () => {
    const h = await harness()
    h.setStored(await running(h))
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 9 * DAY, trialEndsAt: NOW + 30 * DAY } }))
    expect(await h.license.status()).toEqual(TRIAL_STATUS)
    expect(h.getStored()).toMatchObject({ trialReportedAt: NOW })
    await launchReportSettled(h.license)
    expect(h.http.calls).toEqual([{ action: 'trial', body: { fingerprint: 'fp-test', clientStart: NOW - 2 * DAY } }])
    // The answer is not read: the stored trial is as it was.
    expect(h.getStored()).toMatchObject({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY })
  })

  it('at most once a day, a startTrial() answer counting as a report', async () => {
    const h = await harness()
    h.setStored(await running(h))
    await h.license.status()
    h.setClock(NOW + TRIAL_REPORT_MS - 1)
    await h.license.status()
    expect(h.http.count('trial')).toBe(1)
    h.setClock(NOW + TRIAL_REPORT_MS)
    await h.license.status()
    await launchReportSettled(h.license)
    expect(h.http.count('trial')).toBe(2)

    const synced = await harness()
    synced.setStored(await running(synced, { trialAt: NOW - DAY / 2 }))
    await synced.license.status()
    await launchReportSettled(synced.license)
    expect(synced.http.called('trial')).toBe(false)
  })

  it('never holds up the launch: status() has answered by the time the report is sent, no time passing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    h.setStored(await running(h))
    h.http.hang = true
    let answered = false
    const answer = h.license.status().then((status) => {
      answered = true
      return status
    })
    await h.http.whenCalled('trial')
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toBe(true)
    expect(await answer).toEqual(TRIAL_STATUS)
  })

  it("sends nothing from a device whose own fingerprint does not read, after saving the day's stamp", async () => {
    const hostOnly: Fingerprinter = { get: async () => 'unused', identify: async () => ({ fingerprint: null, alternates: ['fp-host'] }) }
    const h = await harness(null, { fingerprint: hostOnly })
    h.setStored(await running(h))
    expect(await h.license.status()).toEqual(TRIAL_STATUS)
    await launchReportSettled(h.license)
    expect(h.getStored()).toMatchObject({ trialReportedAt: NOW })
    expect(h.http.called('trial')).toBe(false)
  })

  it("sends the fingerprint's kind, and the stored start without reading the stash", async () => {
    const machine: Fingerprinter = { get: async () => 'unused', identify: async () => ({ fingerprint: 'fp-own', kind: 'machine', alternates: [] }) }
    const h = await harness(null, { fingerprint: machine })
    h.setStored(await running(h))
    // An earlier start in the stash: read, it would be the start sent.
    h.setRegistry(NOW - 9 * DAY)
    await h.license.status()
    await launchReportSettled(h.license)
    expect(h.http.bodyOf('trial')).toEqual({ fingerprint: 'fp-own', fingerprintKind: 'machine', clientStart: NOW - 2 * DAY })
  })

  it('is bounded as a status check is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    h.setStored(await running(h))
    h.http.hang = true
    await h.license.status()
    await h.http.whenCalled('trial')
    let settled = false
    void launchReportSettled(h.license).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('never fails offline', async () => {
    const h = await harness()
    h.setStored(await running(h))
    h.http.fail = true
    expect(await h.license.status()).toEqual(TRIAL_STATUS)
    await expect(launchReportSettled(h.license)).resolves.toBeUndefined()
  })

  it('sends nothing when its stamp cannot be saved, so it is never sent twice in a day', async () => {
    const h = await harness()
    h.setStored(await running(h))
    h.failWrites()
    expect(await h.license.status()).toEqual(TRIAL_STATUS)
    await launchReportSettled(h.license)
    expect(h.http.called('trial')).toBe(false)
  })

  it('is not made by an expired trial, with a key held, or behind a call that has not finished', async () => {
    const expired = await harness()
    expired.setStored({ ...(await running(expired)), trialLease: undefined, trialEndsAt: NOW - 1 })
    await expired.license.status()
    await launchReportSettled(expired.license)
    expect(expired.http.called('trial')).toBe(false)
    expect(expired.getStored()?.trialReportedAt).toBeUndefined()

    const keyed = await harness()
    keyed.setStored(await running(keyed, { key: 'KEY-1' }))
    await keyed.license.status()
    await launchReportSettled(keyed.license)
    expect(keyed.http.called('trial')).toBe(false)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stalled = await harness()
    stalled.setStored(await running(stalled))
    stalled.hangNextRead()
    void stalled.license.status()
    const later = stalled.license.status()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await later).toEqual({ ...TRIAL_STATUS, stalled: true })
    expect(stalled.http.called('trial')).toBe(false)
    expect(stalled.writes()).toBe(0)
  })
})

describe('every answer parser ignores members it does not know', () => {
  const EXTRA = { future: { nested: [1, 2] }, note: 'added by a later server' }

  it('activate, validate and trial', async () => {
    const h = await harness()
    const lease = await h.sign('KEY-1', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1', ...EXTRA } }))
    h.http.on('validate', () => ({ status: 200, json: { lease, ...EXTRA } }))
    expect(await h.license.activate('KEY-1')).toEqual({ ok: true })
    expect(await h.license.status()).toEqual({ state: 'licensed', key: 'KEY-1' })
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: 'KEY-1' })
    expect(h.http.count('validate')).toBe(1)

    const trial = await harness()
    const trialLease = await trial.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    trial.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY, lease: trialLease, ...EXTRA } }))
    expect(await trial.license.startTrial()).toEqual(TRIAL_STATUS)
  })
})

describe('the launch report on the guarded clock (ahead of the device clock)', () => {
  it('is due, and stamped, by the guarded clock: a report an hour old by the device clock is two days old by it', async () => {
    const h = await harness()
    // A trial lease signed for 30 days, so the trial still runs two days ahead.
    const trialLease = await h.sign('trial:fp-test', 'trial', 30 * 24 * 3600)
    const ahead = NOW + 2 * DAY
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 30 * DAY, trialLease, trialReportedAt: NOW - 3_600_000, lastSeen: ahead })
    expect((await h.license.status()).state).toBe('trial')
    await launchReportSettled(h.license)
    expect(h.http.count('trial')).toBe(1)
    expect(h.getStored()).toMatchObject({ trialReportedAt: ahead })
  })
})
