import { afterEach, describe, it, expect, vi } from 'vitest'
import { licenseFileText } from '@keygrant/shared'
import { DEFAULT_HTTP_TIMEOUT_MS } from './adapters.js'
import { LOCK_GRACE_MS } from './engine.js'
import { launchReportSettled } from './trials.js'
import { NOW, harness, type Harness } from './license.fixture.js'
import { ADA, DAY_S, FILE_LICENSED, KEY, build, keyFileFor, leaseFor, offlineFor } from './license-file.fixture.js'

const DAY_MS = DAY_S * 1000

/** Lets whatever a call left running in the background finish: twenty turns of the timer queue. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a licence file beside a key', () => {
  it('wins over a key this device holds, which keeps working once the file is removed', async () => {
    const h = await harness()
    const lease = await leaseFor(h)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, licenseFile: await offlineFor(h), lastSeen: NOW })
    const app = build(h)
    expect(await app.status()).toEqual(FILE_LICENSED)

    await app.removeLicenseFile()
    expect(h.getStored()).toMatchObject({ key: KEY, lease })
    expect(h.getStored()?.licenseFile).toBeUndefined()
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('is imported over a held key without touching its seat', async () => {
    const h = await harness()
    const lease = await leaseFor(h)
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW })
    const app = build(h)
    expect(await app.importLicenseFile(await offlineFor(h))).toMatchObject({ ok: true, kind: 'offline' })
    expect(h.getStored()).toMatchObject({ key: KEY, activationId: 'act_1', lease })
    await app.removeLicenseFile()
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it('is kept by an activation, typed or from a key file, and still answers', async () => {
    const h = await harness()
    const file = await offlineFor(h)
    h.setStored({ licenseFile: file })
    const lease = await leaseFor(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    const app = build(h)
    expect(await app.activate(KEY)).toEqual({ ok: true })
    expect(h.getStored()).toMatchObject({ key: KEY, licenseFile: file })
    expect(await app.importLicenseFile(await keyFileFor(h))).toMatchObject({ ok: true, kind: 'key' })
    expect(h.getStored()).toMatchObject({ key: KEY, licenseFile: file })
    expect(await app.status()).toEqual(FILE_LICENSED)
  })

  it('is left alone by deactivate(), which releases only the key', async () => {
    const h = await harness()
    const file = await offlineFor(h)
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h), licenseFile: file })
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    const app = build(h)
    expect(await app.deactivate()).toEqual({ released: true })
    expect(h.getStored()).toMatchObject({ licenseFile: file })
    expect(h.getStored()?.key).toBeUndefined()
    expect(await app.status()).toEqual(FILE_LICENSED)
  })

  /**
   * A key held with a second under a day left of its two-day lease (less than half its life, so due to renew
   * early), inside an open upgrade window: an unforced status asks about it and notes this major.
   */
  async function keyDue(h: Harness, licenseFile?: string): Promise<void> {
    const lease = await leaseFor(h, { ttlSeconds: 2 * DAY_S, upgradeUntil: NOW / 1000 + 30 * DAY_S, now: NOW - DAY_MS - 1000 })
    h.setStored({ key: KEY, activationId: 'act_1', lease, checkedMajor: 2, lastSeen: NOW, ...(licenseFile ? { licenseFile } : {}) })
  }

  it('that licenses: the held key is neither renewed nor noted, forced or not, though its lease is due', async () => {
    const h = await harness()
    await keyDue(h, await offlineFor(h))
    const app = build(h)
    expect(await app.status()).toEqual(FILE_LICENSED)
    expect(await app.refresh()).toEqual(FILE_LICENSED)
    await settled()
    expect(h.http.calls).toEqual([])
    expect(h.getStored()?.keptMajor).toBeUndefined()
  })

  it('that licenses, its control: with no file, the same key is asked about and noted unforced, so the test above can see it', async () => {
    const h = await harness()
    await keyDue(h)
    // Waited for by the event, not by time: the renewal lands however slow the machine.
    const answered = build(h).status()
    await h.http.whenCalled('validate')
    await answered
    expect(h.http.count('validate')).toBe(1)
    // The major is noted before the renewal is asked.
    expect(h.getStored()?.keptMajor).toBe(2)
  })

  it("that licenses: answers over the key's stored refusal, asking nothing and writing nothing", async () => {
    const h = await harness()
    // The state the refusal below is asked about with no file that licenses.
    h.setStored({ key: KEY, activationId: 'act_1', refused: 'revoked', licenseFile: await offlineFor(h) })
    const writes = h.writes()
    expect(await build(h).refresh()).toEqual(FILE_LICENSED)
    expect(h.http.calls).toEqual([])
    expect(h.writes()).toBe(writes)
  })

  it('that does not license: gives way to the key', async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', lease: await leaseFor(h), checkedMajor: 2, licenseFile: await offlineFor(h) })
    expect(await build(h, { revokedLicenseFiles: ['lf_1'] }).status()).toEqual({ state: 'licensed', key: KEY })
  })

  it("that does not license: gives way to the key's stored refusal", async () => {
    const h = await harness()
    h.setStored({ key: KEY, activationId: 'act_1', refused: 'revoked', licenseFile: await offlineFor(h) })
    h.http.fail = true
    expect(await build(h, { revokedLicenseFiles: ['lf_1'] }).status()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
    // The refusal is asked about, which the file that licenses above spares.
    expect(h.http.count('validate')).toBe(1)
  })
})

describe('a licence file beside a trial', () => {
  it('that licenses: answers before a running trial, whose launch is then not reported', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * DAY_S)
    // No stamp of a report or a trial answer: a running trial would report its launch now.
    h.setStored({ trialStart: NOW, trialEndsAt: NOW + 5 * DAY_MS, trialLease, licenseFile: await offlineFor(h) })
    const app = build(h)
    const writes = h.writes()
    expect(await app.status()).toEqual(FILE_LICENSED)
    await launchReportSettled(app)
    expect(h.http.calls).toEqual([])
    expect(h.writes()).toBe(writes)
  })

  it('that licenses, its control: with no file, the same trial reports its launch, so the test above can see it', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * DAY_S)
    h.setStored({ trialStart: NOW, trialEndsAt: NOW + 5 * DAY_MS, trialLease })
    const app = build(h)
    expect(await app.status()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY_MS, trialDaysLeft: 5 })
    await launchReportSettled(app)
    expect(h.http.count('trial')).toBe(1)
    expect(h.getStored()?.trialReportedAt).toBe(NOW)
  })

  it('that does not license: gives way to a running trial, so a trial of a build the file does not cover runs', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * DAY_S)
    h.setStored({ trialStart: NOW, trialEndsAt: NOW + 5 * DAY_MS, trialLease, trialAt: NOW, licenseFile: await offlineFor(h, { major: 1 }) })
    expect(await build(h).status()).toEqual({ state: 'trial', trialEndsAt: NOW + 5 * DAY_MS, trialDaysLeft: 5 })
  })

  it('that does not license: answers in place of an ended trial, since why the file does not cover this build is the news', async () => {
    const h = await harness()
    const trialLease = await h.sign('trial:fp-test', 'trial', 5 * DAY_S, NOW - 10 * DAY_MS)
    h.setStored({ trialStart: NOW - 10 * DAY_MS, trialEndsAt: NOW - 5 * DAY_MS, trialLease, trialAt: NOW, licenseFile: await offlineFor(h, { major: 1 }) })
    expect(await build(h).status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY, source: 'file', licensedTo: ADA })
    expect(h.http.calls).toEqual([])
  })
})

describe('a key file', () => {
  it('activates its key online, as a typed key, and stores the activation, never the file', async () => {
    const h = await harness()
    const lease = await leaseFor(h)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    const app = build(h)

    expect(await app.importLicenseFile(licenseFileText(await keyFileFor(h)))).toEqual({ ok: true, kind: 'key', licensedTo: { email: ADA.email } })
    // The key as a typed one is sent: normalised.
    expect(h.http.bodyOf('activate')).toMatchObject({ key: KEY, major: 2 })
    expect(h.getStored()).toMatchObject({ key: KEY, activationId: 'act_1', lease })
    expect(h.getStored()?.licenseFile).toBeUndefined()
    expect(await app.status()).toEqual({ state: 'licensed', key: KEY })
  })

  it("answers with activate()'s error when the server refuses the key", async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'limit' } }))
    expect(await build(h).importLicenseFile(await keyFileFor(h))).toEqual({ ok: false, error: 'limit' })
    h.http.fail = true
    expect(await build(h).importLicenseFile(await keyFileFor(h))).toEqual({ ok: false, error: 'network' })
  })

  it('rejects where activate() does: the state cannot be read', async () => {
    const h = await harness()
    const app = build(h)
    h.failRead(1)
    await expect(app.importLicenseFile(await keyFileFor(h))).rejects.toThrow(/EBUSY/)
    expect(h.http.calls).toEqual([])
  })

  it('is refused before any request when it is not for this app, judging no version', async () => {
    const h = await harness()
    const app = build(h, { revokedLicenseFiles: ['lf_2'] })
    expect(await app.importLicenseFile(await keyFileFor(h, { product: 'maindeck' }))).toEqual({ ok: false, error: 'wrong-product' })
    expect(await app.importLicenseFile(await keyFileFor(h))).toEqual({ ok: false, error: 'revoked-file' })
    expect(h.http.calls).toEqual([])
  })
})

describe('licence files and a call that has not finished', () => {
  it('import and remove reject, writing nothing, while status() answers from the stored file, saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    const token = await offlineFor(h)
    h.setStored({ licenseFile: token })
    const app = build(h)
    h.hangNextRead()
    void app.status()
    const imported = app.importLicenseFile(token).catch((e: unknown) => e)
    const removed = app.removeLicenseFile().catch((e: unknown) => e)
    const answered = app.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + LOCK_GRACE_MS)
    expect(await imported).toMatchObject({ message: expect.stringMatching(/previous licence call has not finished/) })
    expect(await removed).toMatchObject({ message: expect.stringMatching(/previous licence call has not finished/) })
    expect(await answered).toEqual({ ...FILE_LICENSED, stalled: true })
    expect(h.writes()).toBe(0)
  })
})
