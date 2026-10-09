import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { generateKeyPair, importSigningKey, importVerifyingKey, keyId, signLease, verifyLease } from '@keygrant/shared'
import { CLAIM_EAGER_MS, CLAIM_WAIT_MS, PURCHASE_TOKEN_MS } from './offline.js'
import { STATUS_CHECK_TIMEOUT_MS } from './wire.js'
import { DEFAULT_HTTP_TIMEOUT_MS } from './adapters.js'
import { License } from './license.js'
import { launchReportSettled } from './trials.js'
import type { DeviceIdentity, Fingerprinter, RegistryStash, StorageAdapter, StoredState } from './types.js'
import { DAY, NOW, PRODUCT, harness, type Harness } from './license.fixture.js'

const HOUR = 3_600_000

const LINK = 'https://buy.stripe.com/test_abc'
/** The purchase secret held: it stays on the device. */
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
/** What a link carries for a secret: kgp_ and the base64url of its SHA-256, derived here on its own. */
const referenceOf = (secret: string) => `kgp_${createHash('sha256').update(secret).digest('base64url')}`
const REF = referenceOf(TOKEN)
const BOUGHT_KEY = 'SLUICE-BUY1-BUY1-BUY1-BUY1'

/** A fingerprinter whose machine id never reads in time: only the host-name fingerprint, as an alternate. */
function hostOnly(calls: { n: number } = { n: 0 }, delayMs = 0): Fingerprinter {
  const identity: DeviceIdentity = { fingerprint: null, alternates: ['fp-host'] }
  return {
    get: async () => 'unused',
    identify: () => {
      calls.n += 1
      return new Promise((resolve) => (delayMs > 0 ? setTimeout(() => resolve(identity), delayMs) : resolve(identity)))
    },
  }
}

/** A running trial, synced within the day (so no launch report is due), with `over` on top. */
async function trialState(h: Harness, over: StoredState = {}): Promise<StoredState> {
  const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
  return { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease, trialAt: NOW - DAY / 2, lastSeen: NOW, ...over }
}

/** A purchase token held, handed out `ago` ms before NOW. */
const held = (ago = 0, over: StoredState = {}): StoredState => ({ purchaseToken: TOKEN, purchaseTokenAt: NOW - ago, ...over })

/** The server's answer when the key bought with the token is this device's: as an activation's. */
async function bought(h: Harness, model: 'perpetual' | 'trial' = 'perpetual') {
  const lease = await h.sign(BOUGHT_KEY, model, 30 * 24 * 3600)
  return { status: 200, json: { key: BOUGHT_KEY, activationId: 'act_1', lease, inGrace: false, validUntil: null } }
}

const TRIAL_STATUS = { state: 'trial', trialEndsAt: NOW + 5 * DAY, trialDaysLeft: 5 }

/** The purchase token and its stamps. */
const PURCHASE_FIELDS = ['purchaseToken', 'purchaseTokenAt', 'claimAskedAt'] as const

/** The fields of `state` that hold a value (a save writes a cleared field as undefined, which JSON drops). */
const setFields = (state: StoredState | null) => Object.keys(state ?? {}).filter((f) => state?.[f as keyof StoredState] !== undefined)

afterEach(() => {
  vi.useRealTimers()
})

describe('purchaseUrl', () => {
  it('keeps a new secret of 256 random bits, and puts only the reference to it (kgp_ and its SHA-256) in the link', async () => {
    const h = await harness()
    const url = await h.license.purchaseUrl(LINK)
    const secret = h.getStored()?.purchaseToken ?? ''
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url).toBe(`${LINK}?client_reference_id=${referenceOf(secret)}`)
    expect(url).not.toContain(secret)
    expect(h.getStored()).toMatchObject({ purchaseTokenAt: NOW })
    expect(h.http.calls).toHaveLength(0)
  })

  it("hands the held secret's link out again, its bound counted from this call, and clears the claim's wait", async () => {
    const h = await harness(held(10 * DAY, { claimAskedAt: NOW - 1000 }))
    h.setClock(NOW + 1000)
    expect(await h.license.purchaseUrl(LINK)).toBe(`${LINK}?client_reference_id=${REF}`)
    expect(h.getStored()).toEqual(expect.objectContaining({ purchaseToken: TOKEN, purchaseTokenAt: NOW + 1000 }))
    expect(setFields(h.getStored())).not.toContain('claimAskedAt')
  })

  it('makes a new secret once the held one is past its bound', async () => {
    const h = await harness(held(PURCHASE_TOKEN_MS))
    const url = await h.license.purchaseUrl(LINK)
    expect(url).not.toContain(REF)
    expect(h.getStored()?.purchaseToken).not.toBe(TOKEN)
  })

  it("keeps the link's own parameters and fragment, and replaces a client_reference_id already on it", async () => {
    const h = await harness(held())
    const url = await h.license.purchaseUrl('https://buy.stripe.com/x?prefilled_email=jo%40example.com&client_reference_id=old#pay')
    expect(url).toBe(`https://buy.stripe.com/x?prefilled_email=jo%40example.com&client_reference_id=${REF}#pay`)
  })

  it('is null while any key is held, and saves nothing', async () => {
    const lease = 'header.payload.sig'
    for (const state of [{ key: 'KEY-1', activationId: 'act_1', lease }, { key: 'KEY-1', refused: 'revoked' as const }, { key: 'KEY-1' }]) {
      const h = await harness(state)
      expect(await h.license.purchaseUrl(LINK)).toBeNull()
      expect(h.writes()).toBe(0)
    }
  })

  it('rejects a link that is not an absolute URL, before reading anything', async () => {
    const h = await harness()
    h.hangNextRead()
    for (const link of ['buy.stripe.com/test_abc', '/buy', '']) await expect(h.license.purchaseUrl(link)).rejects.toThrow(TypeError)
  })

  it('rejects when the state cannot be read, or the token cannot be saved', async () => {
    const unreadable = await harness()
    unreadable.failRead(1)
    await expect(unreadable.license.purchaseUrl(LINK)).rejects.toThrow()
    const unsaved = await harness()
    unsaved.failWrites()
    await expect(unsaved.license.purchaseUrl(LINK)).rejects.toThrow()
  })

  it('behind a call that has not finished: the held token as it is, and a rejection when none is held', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held(DAY))
    h.hangNextRead()
    void h.license.status()
    const later = h.license.purchaseUrl(LINK)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toBe(`${LINK}?client_reference_id=${REF}`)
    expect(h.writes()).toBe(0)

    const none = await harness()
    none.hangNextRead()
    void none.license.status()
    const refused = none.license.purchaseUrl(LINK)
    const settled = expect(refused).rejects.toThrow('has not finished')
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    await settled
  })

  it('behind a call that has not finished, a held secret past its bound rejects and nothing is written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held(PURCHASE_TOKEN_MS))
    h.hangNextRead()
    void h.license.status()
    const refused = h.license.purchaseUrl(LINK)
    const settled = expect(refused).rejects.toThrow('has not finished')
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    await settled
    expect(h.writes()).toBe(0)
  })
})

describe('the pickup: status() asks for the key bought with the token', () => {
  it('saves a bought key exactly as activate(key) does, clears the token, and answers licensed', async () => {
    const h = await harness(null, { deviceName: 'Rae’s laptop' })
    h.setStored(await trialState(h, held()))
    h.http.on('claim', () => bought(h))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    // The secret, never the reference, and every fingerprint this device answers to, as a validate sends them.
    expect(h.http.bodyOf('claim')).toEqual({ token: TOKEN, fingerprint: 'fp-test', fingerprints: ['fp-test'], name: 'Rae’s laptop', major: 1, kids: [await keyId(h.publicJwk)] })
    const stored = h.getStored() ?? {}
    expect(stored).toMatchObject({ key: BOUGHT_KEY, activationId: 'act_1', checkedMajor: 1, verdictAt: NOW })
    for (const field of PURCHASE_FIELDS) expect(setFields(stored)).not.toContain(field)
    // Licensed from then on, offline, and never asked again.
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    expect(h.http.count('claim')).toBe(1)
    expect(h.http.called('trial')).toBe(false)
  })

  it('on "not bought yet" answers the trial, keeps the token, and asks again only after the wait', async () => {
    const h = await harness()
    h.setStored(await trialState(h, held()))
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    expect(await h.license.status()).toEqual(TRIAL_STATUS)
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
    h.setClock(NOW + CLAIM_WAIT_MS - 1)
    await h.license.status()
    expect(h.http.count('claim')).toBe(1)
    h.setClock(NOW + CLAIM_WAIT_MS)
    await h.license.status()
    expect(h.http.count('claim')).toBe(2)
  })

  it('asks at once on refresh(), and when the clock was set back before the last ask', async () => {
    const h = await harness()
    h.setStored(await trialState(h, held(0, { claimAskedAt: NOW - 1000 })))
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await h.license.refresh()
    expect(h.http.count('claim')).toBe(1)
    h.setStored({ ...(h.getStored() ?? {}), claimAskedAt: NOW + 60_000 })
    await h.license.status()
    expect(h.http.count('claim')).toBe(2)
  })

  it('keeps the token when nothing answers, or the answer carries no error word', async () => {
    for (const answer of [null, { status: 503, json: { error: 'internal' } }, { status: 404, json: '<html>' }, { status: 200, json: 'portal' }]) {
      const h = await harness({ ...held() })
      if (answer === null) h.http.fail = true
      else h.http.on('claim', () => answer)
      expect(await h.license.status()).toEqual({ state: 'unlicensed' })
      expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
    }
  })

  it('drops the token on an error word, and on a key whose lease does not license this build', async () => {
    const h = await harness()
    const elsewhere = await signLease(
      { sub: BOUGHT_KEY, product: 'another-product', aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 86_400 },
      h.signingKey,
      NOW,
    )
    const answers = [
      { status: 409, json: { error: 'spent' } },
      { status: 403, json: { error: 'pickup-off' } },
      { status: 403, json: { error: 'limit' } },
      { status: 200, json: { key: BOUGHT_KEY, activationId: 'act_1', lease: elsewhere } },
    ]
    for (const answer of answers) {
      h.setStored(await trialState(h, held()))
      h.http.on('claim', () => answer)
      expect(await h.license.status()).toEqual(TRIAL_STATUS)
      for (const field of [...PURCHASE_FIELDS, 'key']) expect(setFields(h.getStored())).not.toContain(field)
    }
    await h.license.refresh()
    expect(h.http.count('claim')).toBe(answers.length)
  })

  it('drops a token past its bound without sending it', async () => {
    const h = await harness(held(PURCHASE_TOKEN_MS))
    expect(await h.license.refresh()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('claim')).toBe(false)
    expect(setFields(h.getStored())).not.toContain('purchaseToken')
  })

  it('saves a drop about its token: a token another process made meanwhile stays', async () => {
    const h = await harness(held())
    h.http.on('claim', () => {
      h.setStored({ purchaseToken: 'kgp_another-process-made-this-one-meanwhile', purchaseTokenAt: NOW })
      return { status: 409, json: { error: 'spent' } }
    })
    await h.license.status()
    expect(h.getStored()).toMatchObject({ purchaseToken: 'kgp_another-process-made-this-one-meanwhile', purchaseTokenAt: NOW })
  })

  it('bounds an unforced claim as a status check is, keeping the token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held())
    h.http.hang = true
    let settled = false
    const pending = h.license.status().then((s) => {
      settled = true
      return s
    })
    await h.http.whenCalled('claim')
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ state: 'unlicensed' })
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
  })

  it('answers a bought key even when the disk refuses it, and the next status() asks again with the same fingerprints', async () => {
    const h = await harness(held())
    h.http.on('claim', () => bought(h))
    h.failWrites()
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    h.failWrites(false)
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    const bodies = h.http.calls.filter((c) => c.action === 'claim').map((c) => c.body)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[0]).toMatchObject({ fingerprints: ['fp-test'] })
    expect(h.getStored()).toMatchObject({ key: BOUGHT_KEY })
  })

  it('sends every fingerprint the run read when the device is not held, too: its own and the host name', async () => {
    const both: Fingerprinter = { get: async () => 'unused', identify: async () => ({ fingerprint: 'fp-own', kind: 'machine', alternates: ['fp-host'] }) }
    const h = await harness(held(), { deviceHold: false, fingerprint: both })
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await h.license.status()
    expect(h.http.bodyOf('claim')).toEqual({ token: TOKEN, fingerprint: 'fp-own', fingerprints: ['fp-own', 'fp-host'], major: 1, kids: [await keyId(h.publicJwk)] })
  })

  it("bounds a forced claim (refresh()) by the HTTP bound, not a status check's", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held())
    h.http.hang = true
    let settled = false
    const pending = h.license.refresh().then((s) => {
      settled = true
      return s
    })
    await h.http.whenCalled('claim')
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS - STATUS_CHECK_TIMEOUT_MS)
    expect(settled).toBe(true)
    expect(await pending).toEqual({ state: 'unlicensed' })
  })

  it("judges the link's day by the guarded clock and the wait by the device clock", async () => {
    // The guarded clock a day ahead of the device clock (lastSeen): a link an hour old by the
    // device clock is stale by it.
    const stale = await harness(held(HOUR, { lastSeen: NOW + DAY }))
    await stale.license.status()
    expect(stale.http.called('claim')).toBe(false)
    // Fresh by the guarded clock, but asked a second ago by the device clock: the wait still runs.
    const waiting = await harness(held(-(DAY - HOUR), { lastSeen: NOW + DAY, claimAskedAt: NOW - 1000 }))
    await waiting.license.status()
    expect(waiting.http.called('claim')).toBe(false)
    // Neither was dropped: refresh() asks.
    stale.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await stale.license.refresh()
    expect(stale.http.count('claim')).toBe(1)
  })

  it('sends the secret in no request but the claim', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.setStored({ trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, trialLease, lastSeen: NOW, ...held() })
    const lease = await h.sign('KEY-1', 'perpetual', 30 * 24 * 3600)
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW - 2 * DAY, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('validate', () => ({ status: 200, json: { lease } }))
    await h.license.status() // a claim and the launch report
    await launchReportSettled(h.license)
    await h.license.startTrial() // a claim and the trial ask
    await h.license.activate('KEY-1') // the secret still held when its body is made
    // A key and a secret stored together (purchaseUrl's save is unbased: it can land on a key another process
    // activated meanwhile): a validate and a deactivate made while the secret is held.
    h.setStored({ key: 'KEY-1', activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW, ...held() })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    await h.license.refresh()
    await h.license.deactivate()
    const actions = h.http.calls.map((c) => c.action)
    expect(actions).toEqual(['claim', 'trial', 'claim', 'trial', 'activate', 'validate', 'deactivate'])
    for (const call of h.http.calls) expect(JSON.stringify(call.body).includes(TOKEN), call.action).toBe(call.action === 'claim')
  })

  it('sends the server at most 4 fingerprints, own first, each of 1 to 200 characters', async () => {
    const many: Fingerprinter = {
      get: async () => 'unused',
      identify: async () => ({ fingerprint: 'fp-own', kind: 'machine', alternates: ['fp-a1', 'x'.repeat(201), 'fp-a2', '', 'y'.repeat(200), 'fp-a4'] }),
    }
    const h = await harness(held(), { fingerprint: many })
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await h.license.status()
    expect(h.http.bodyOf('claim')).toMatchObject({ fingerprint: 'fp-own', fingerprints: ['fp-own', 'fp-a1', 'fp-a2', 'y'.repeat(200)] })
  })

  it('never claims under a host-name fallback from status() or refresh(): no ask, and no wait started', async () => {
    const h = await harness(held(), { fingerprint: hostOnly() })
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    expect(await h.license.status()).toEqual({ state: 'unlicensed' })
    expect(await h.license.refresh()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('claim')).toBe(false)
    expect(setFields(h.getStored())).not.toContain('claimAskedAt')
  })

  it('asks unforced only for a day after the link; then only refresh() asks', async () => {
    const fresh = await harness(held(CLAIM_EAGER_MS - 1))
    fresh.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await fresh.license.status()
    expect(fresh.http.count('claim')).toBe(1)

    const stale = await harness(held(CLAIM_EAGER_MS))
    stale.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    expect(await stale.license.status()).toEqual({ state: 'unlicensed' })
    expect(stale.http.called('claim')).toBe(false)
    await stale.license.refresh()
    expect(stale.http.count('claim')).toBe(1)
  })

  it('a link handed out again while a claim is out: its "not bought yet" does not start the wait again', async () => {
    const h = await harness(held(DAY / 2))
    h.http.on('claim', () => {
      // Another process's purchaseUrl() hands the same secret's link out again, clearing the wait.
      h.setStored({ ...(h.getStored() ?? {}), purchaseTokenAt: NOW, claimAskedAt: undefined })
      return { status: 200, json: { pending: true } }
    })
    await h.license.status()
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, purchaseTokenAt: NOW })
    expect(setFields(h.getStored())).not.toContain('claimAskedAt')
  })

  it('asks nothing while a key is held, or behind a call that has not finished', async () => {
    const keyed = await harness({ key: 'KEY-1', ...held() })
    await keyed.license.refresh()
    expect(keyed.http.called('claim')).toBe(false)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held())
    h.hangNextRead()
    void h.license.status()
    const later = h.license.status(true)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toEqual({ state: 'unlicensed', stalled: true })
    expect(h.http.called('claim')).toBe(false)
  })
})

describe('the pickup at startTrial()', () => {
  /** A License over `h`'s storage and server, its fingerprinter and a stash that counts its reads. */
  function startable(h: Harness, fingerprint: Fingerprinter) {
    const stash = { reads: 0 }
    const registry: RegistryStash = {
      readTrialStart: async () => {
        stash.reads += 1
        return null
      },
      writeTrialStart: async () => undefined,
    }
    const license = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, fingerprint, registry } })
    return { license, stash }
  }

  it('reads the device once for both asks, and may claim under the host name', async () => {
    // A machine id that does not read the first time, and would the second.
    const reads = { n: 0 }
    const flaky: Fingerprinter = {
      get: async () => 'unused',
      identify: async () => {
        reads.n += 1
        return reads.n === 1 ? { fingerprint: null, alternates: ['fp-host'] } : { fingerprint: 'fp-late', kind: 'machine', alternates: [] }
      },
    }
    const h = await harness(held())
    const { license, stash } = startable(h, flaky)
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    expect(await license.startTrial()).toEqual({ state: 'unlicensed' })
    expect(reads.n).toBe(1)
    expect(h.http.bodyOf('claim')).toEqual({ token: TOKEN, fingerprint: 'fp-host', fingerprintKind: 'hostname', fingerprints: ['fp-host'], major: 1, kids: [await keyId(h.publicJwk)] })
    // The trial ask was made (the stash read), under the same reading: no own fingerprint, so no trial request.
    expect(stash.reads).toBe(1)
    expect(h.http.calls.map((c) => c.action)).toEqual(['claim'])
  })

  it('with no fingerprint at all: no claim sent, the wait started as for no answer, and the trial still asked', async () => {
    const none: Fingerprinter = { get: async () => 'unused', identify: async () => ({ fingerprint: null, alternates: [] }) }
    const h = await harness(held())
    const { license, stash } = startable(h, none)
    expect(await license.startTrial()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('claim')).toBe(false)
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
    expect(stash.reads).toBe(1)
  })

  it('claims nothing behind a call that has not finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held())
    h.hangNextRead()
    void h.license.status()
    const later = h.license.startTrial()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    expect(await later).toEqual({ state: 'unlicensed', stalled: true })
    expect(h.http.called('claim')).toBe(false)
    expect(h.writes()).toBe(0)
  })

  it('bounds its claim as a status check is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness(held())
    h.http.hang = true
    void h.license.startTrial()
    await h.http.whenCalled('claim')
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS - 1)
    expect(h.http.called('trial')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await h.http.whenCalled('trial')
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
  })

  it('holds the calls behind it for its longest run (device read, claim and trial ask), not running them read-only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // A machine id that reads just inside an activation's time, then a claim and a trial ask that never answer.
    const slow: Fingerprinter = {
      get: async () => 'unused',
      identify: () => new Promise((resolve) => setTimeout(() => resolve({ fingerprint: 'fp-slow', kind: 'machine', alternates: [] }), 10_500)),
    }
    const h = await harness(held(), { fingerprint: slow })
    h.http.hang = true
    const started = h.license.startTrial()
    const behind = h.license.status()
    // Step by step, each request waited for, so no bound is passed before its request is made.
    await vi.advanceTimersByTimeAsync(10_500)
    await h.http.whenCalled('claim')
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS)
    await h.http.whenCalled('trial')
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 1)
    expect(await started).toEqual({ state: 'unlicensed' })
    expect(await behind).toEqual({ state: 'unlicensed' })
  })

  it('asks the claim before the trial, whatever the wait says, and a bought key is the answer with no trial asked', async () => {
    const h = await harness(held(0, { claimAskedAt: NOW - 1000 }))
    h.http.on('claim', () => bought(h))
    expect(await h.license.startTrial()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    expect(h.http.calls.map((c) => c.action)).toEqual(['claim'])
  })

  it('asks for the trial after a claim that brought no key', async () => {
    const h = await harness(held())
    const lease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY, lease } }))
    expect(await h.license.startTrial()).toEqual(TRIAL_STATUS)
    expect(h.http.calls.map((c) => c.action)).toEqual(['claim', 'trial'])
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
  })
})

describe('an activation and a deactivation clear the purchase token', () => {
  it('a typed key clears it, so a later deactivate leaves no pickup pending', async () => {
    const h = await harness(held())
    const lease = await h.sign('KEY-1', 'perpetual', 30 * 24 * 3600)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate('KEY-1')).toEqual({ ok: true })
    for (const field of PURCHASE_FIELDS) expect(setFields(h.getStored())).not.toContain(field)
  })

  it('deactivate clears it', async () => {
    const h = await harness({ key: 'KEY-1', activationId: 'act_1', ...held() })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    await h.license.deactivate()
    for (const field of PURCHASE_FIELDS) expect(setFields(h.getStored())).not.toContain(field)
  })
})

describe("a key bought from a trial model's own price (model trial)", () => {
  it('licenses the app as a licence, and is never read as a trial', async () => {
    const h = await harness(held())
    h.http.on('claim', () => bought(h, 'trial'))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    expect(setFields(h.getStored())).not.toContain('trialLease')
  })

  it('licenses a typed key as well, offline', async () => {
    const h = await harness()
    const lease = await h.sign('KEY-1', 'trial', 30 * 24 * 3600)
    h.setStored({ key: 'KEY-1', activationId: 'act_1', lease, checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: 'KEY-1' })
  })
})

describe("a claim's answer, checked and saved", () => {
  /** A bought key's lease signed by a key that is not the product's. */
  async function signedElsewhere(): Promise<string> {
    const other = await importSigningKey((await generateKeyPair()).privateJwk)
    const claims = { sub: BOUGHT_KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual' as const, lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 86_400 }
    return signLease(claims, other, NOW)
  }

  /** The product's own lease for the bought key, one claim in its payload changed and the original signature kept. */
  async function tampered(h: Harness): Promise<string> {
    const [header, payload, signature] = (await h.sign(BOUGHT_KEY, 'perpetual', 30 * 24 * 3600)).split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const forged = Buffer.from(JSON.stringify({ ...claims, lim: 99 })).toString('base64url')
    return `${header}.${forged}.${signature}`
  }

  it("refuses a lease signed by another key, or tampered under the product's signature: nothing saved, the secret dropped, the trial asked", async () => {
    for (const make of [signedElsewhere, tampered]) {
      const h = await harness(held())
      const lease = await make(h)
      // Refused by its signature, both: the tampered payload still parses as claims.
      expect(await verifyLease(lease, await importVerifyingKey(h.publicJwk), NOW)).toMatchObject({ valid: false, reason: 'bad-signature' })
      const trialLease = await h.sign('trial:fp-test', 'trial', 5 * 24 * 3600)
      h.http.on('claim', () => ({ status: 200, json: { key: BOUGHT_KEY, activationId: 'act_1', lease } }))
      h.http.on('trial', () => ({ status: 200, json: { trialStart: NOW, trialEndsAt: NOW + 5 * DAY, lease: trialLease } }))
      expect(await h.license.startTrial()).toEqual(TRIAL_STATUS)
      expect(h.http.calls.map((c) => c.action)).toEqual(['claim', 'trial'])
      for (const field of [...PURCHASE_FIELDS, 'key', 'activationId', 'lease']) expect(setFields(h.getStored())).not.toContain(field)
    }
  })

  it("judges the bought lease at the server's time, bringing the clock guard back", async () => {
    // A clock that once jumped 60 days ahead, put right since: the guard (lastSeen) is still there,
    // and the link was handed out an hour before by it. The lease, signed now for 30 days, reads as
    // expired by the guard.
    const ahead = NOW + 60 * DAY
    const h = await harness(held(0, { purchaseTokenAt: ahead - HOUR, lastSeen: ahead }))
    h.http.on('claim', () => bought(h))
    expect(await h.license.status()).toEqual({ state: 'licensed', key: BOUGHT_KEY })
    expect(h.getStored()).toMatchObject({ key: BOUGHT_KEY, lastSeen: NOW })
  })

  it('saves the drop of a secret past its bound about that secret: a new one another process made stays', async () => {
    const h = await harness(held(PURCHASE_TOKEN_MS))
    const NEWER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    let first = true
    // Another process hands out a new secret's link just after this status() has read the state.
    const storage: StorageAdapter = {
      read: async (opts) => {
        const state = await h.adapters.storage.read(opts)
        if (first) {
          first = false
          h.setStored({ purchaseToken: NEWER, purchaseTokenAt: NOW, lastSeen: NOW })
        }
        return state
      },
      write: (state) => h.adapters.storage.write(state),
    }
    const license = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: h.publicJwk, adapters: { ...h.adapters, storage } })
    expect(await license.status()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('claim')).toBe(false)
    expect(h.getStored()).toMatchObject({ purchaseToken: NEWER, purchaseTokenAt: NOW })
  })

  it("lands a drop even after the same secret's link was handed out again", async () => {
    const h = await harness(held(DAY / 2))
    h.http.on('claim', () => {
      // Another process's purchaseUrl() hands the same secret's link out again while the claim is out.
      h.setStored({ ...(h.getStored() ?? {}), purchaseTokenAt: NOW, claimAskedAt: undefined })
      return { status: 409, json: { error: 'spent' } }
    })
    await h.license.status()
    for (const field of PURCHASE_FIELDS) expect(setFields(h.getStored())).not.toContain(field)
  })

  it('answers when the disk refuses a wait or a drop', async () => {
    const answers = [
      { status: 200, json: { pending: true } },
      { status: 409, json: { error: 'spent' } },
    ]
    for (const answer of answers) {
      const h = await harness()
      h.setStored(await trialState(h, held()))
      h.http.on('claim', () => answer)
      h.failWrites()
      expect(await h.license.status()).toEqual(TRIAL_STATUS)
      expect(h.http.count('claim')).toBe(1)
    }
    const past = await harness()
    past.setStored(await trialState(past, held(PURCHASE_TOKEN_MS)))
    past.failWrites()
    expect(await past.license.status()).toEqual(TRIAL_STATUS)
  })
})

describe('each purchase stamp on its own clock (the guarded clock ahead of the device clock)', () => {
  /** The guard (lastSeen) 40 days ahead of the device clock, as after a clock set back. */
  const AHEAD = 40 * DAY

  it('purchaseUrl keeps a secret by the guarded clock: one a day old by the device clock is past its bound', async () => {
    const h = await harness(held(DAY, { lastSeen: NOW + AHEAD }))
    const url = await h.license.purchaseUrl(LINK)
    expect(url).not.toContain(REF)
    expect(h.getStored()?.purchaseToken).not.toBe(TOKEN)
  })

  it('purchaseUrl stamps its link by the guarded clock', async () => {
    const h = await harness(held(0, { purchaseTokenAt: NOW + AHEAD - DAY, lastSeen: NOW + AHEAD }))
    expect(await h.license.purchaseUrl(LINK)).toBe(`${LINK}?client_reference_id=${REF}`)
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, purchaseTokenAt: NOW + AHEAD })
  })

  it('drops a secret past its 30-day bound by the guarded clock, unsent, though a day old by the device clock', async () => {
    const h = await harness(held(DAY, { lastSeen: NOW + AHEAD }))
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    expect(await h.license.refresh()).toEqual({ state: 'unlicensed' })
    expect(h.http.called('claim')).toBe(false)
    expect(setFields(h.getStored())).not.toContain('purchaseToken')
  })

  it('stamps the wait after a claim by the device clock', async () => {
    const h = await harness(held(0, { purchaseTokenAt: NOW + AHEAD - HOUR, lastSeen: NOW + AHEAD }))
    h.http.on('claim', () => ({ status: 200, json: { pending: true } }))
    await h.license.refresh()
    expect(h.http.count('claim')).toBe(1)
    expect(h.getStored()).toMatchObject({ purchaseToken: TOKEN, claimAskedAt: NOW })
  })
})
