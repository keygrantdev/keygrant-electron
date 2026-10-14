import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { generateKeyPair, importSigningKey, keyId, licenseFileText, signLicenseFile } from '@keygrant/shared'
import { MissingEntitlementError } from './entitlements.js'
import { DAY, NOW, harness } from './license.fixture.js'
import { ADA, FILE_LICENSED, KEY, OFFLINE, build, keyFileFor, leaseFor, offlineFor, storedFile } from './license-file.fixture.js'

describe('an offline licence file', () => {
  it('is taken from its text with no network, stored, and licenses the app as the file', async () => {
    const h = await harness()
    const token = await offlineFor(h)
    const app = build(h)

    const result = await app.importLicenseFile(licenseFileText(token))
    expect(result).toEqual({ ok: true, kind: 'offline', licensedTo: ADA })
    expect(h.getStored()?.licenseFile).toBe(token)
    const status = await app.status()
    expect(status).toEqual(FILE_LICENSED)
    expect(h.http.calls).toEqual([])
    // Each answer holds its own copy of who it is licensed to, which the app cannot change.
    expect(result.ok && Object.isFrozen(result.licensedTo)).toBe(true)
    expect(Object.isFrozen(status.licensedTo)).toBe(true)
  })

  it('is taken as bytes too: a byte array, a Node Buffer, an ArrayBuffer, and arrays made in another realm', async () => {
    const h = await harness()
    const token = await offlineFor(h)
    const text = licenseFileText(token)
    const bytes = new TextEncoder().encode(text)
    // What an Electron renderer or a worker hands over: its own realm's Uint8Array and ArrayBuffer.
    const foreign = runInNewContext('(list) => new Uint8Array(list)')(Array.from(bytes)) as Uint8Array<ArrayBuffer>
    expect(foreign instanceof Uint8Array).toBe(false)
    const contents = [bytes, Buffer.from(text), bytes.buffer, foreign, foreign.buffer]
    for (const [i, content] of contents.entries()) {
      h.setStored(null)
      expect(await build(h).importLicenseFile(content), `content ${i}`).toEqual({ ok: true, kind: 'offline', licensedTo: ADA })
      expect(h.getStored()?.licenseFile, `content ${i}`).toBe(token)
    }
  })

  it('never goes online, refresh() included, and writes nothing to answer, though the key beside it has run out', async () => {
    const h = await harness()
    // Without the file, this run-out lease would be asked about, and the wait after the ask saved.
    const expired = await leaseFor(h, { ttlSeconds: 3600, now: NOW - 2 * DAY })
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, lastSeen: NOW, licenseFile: await offlineFor(h) })
    const app = build(h)
    const writes = h.writes()
    expect(await app.status()).toEqual(FILE_LICENSED)
    expect(await app.refresh()).toEqual(FILE_LICENSED)
    expect(h.http.calls).toEqual([])
    expect(h.writes()).toBe(writes)
  })

  it('never goes online, its control: with no file, the same run-out key is asked about and the answer saved', async () => {
    const h = await harness()
    const expired = await leaseFor(h, { ttlSeconds: 3600, now: NOW - 2 * DAY })
    h.setStored({ key: KEY, activationId: 'act_1', lease: expired, lastSeen: NOW })
    const writes = h.writes()
    await build(h).status()
    expect(h.http.count('validate')).toBe(1)
    expect(h.writes()).toBeGreaterThan(writes)
  })

  it('says when it is a test licence, and carries its entitlements, which has() and require() read', async () => {
    const h = await harness()
    h.setStored({ licenseFile: await offlineFor(h, { test: true, ent: { edition: 'pro', cloud: true } }) })
    const app = build(h)
    expect(await app.status()).toEqual({ ...FILE_LICENSED, test: true, entitlements: { edition: 'pro', cloud: true } })
    expect(await app.has('cloud')).toBe(true)
    await expect(app.require('export')).rejects.toBeInstanceOf(MissingEntitlementError)
  })

  it('removing none is no error, and leaves unlicensed as it was', async () => {
    const h = await harness()
    const app = build(h)
    await app.removeLicenseFile()
    expect(await app.status()).toEqual({ state: 'unlicensed' })
  })

  it('replaces the file stored before, and a file refused leaves the stored one as it was', async () => {
    const h = await harness()
    const first = await offlineFor(h)
    const second = await offlineFor(h, { fid: 'lf_3', name: 'Grace Hopper', email: undefined })
    const app = build(h)
    await app.importLicenseFile(first)
    expect(await app.importLicenseFile(second)).toEqual({ ok: true, kind: 'offline', licensedTo: { name: 'Grace Hopper' } })
    expect(h.getStored()?.licenseFile).toBe(second)
    expect(await app.importLicenseFile(await offlineFor(h, { product: 'maindeck' }))).toEqual({ ok: false, error: 'wrong-product' })
    expect(h.getStored()?.licenseFile).toBe(second)
  })
})

describe('a licence file refused', () => {
  it('names each reason, and stores nothing', async () => {
    const h = await harness()
    const other = await generateKeyPair()
    const token = await offlineFor(h)
    const [header, , signature] = token.split('.') as [string, string, string]
    const otherPayload = (await offlineFor(h, { major: 9 })).split('.')[1] as string
    const byOther = await signLicenseFile(OFFLINE, await importSigningKey(other.privateJwk), await keyId(other.publicJwk), NOW)
    const app = build(h, { revokedLicenseFiles: ['lf_9'] })
    const cases: [string | Uint8Array, string][] = [
      ['', 'malformed'],
      [`${token}\n${token}`, 'malformed'],
      [new Uint8Array([0xff, 0xfe, 0x00]), 'malformed'],
      [await leaseFor(h), 'not-a-license-file'],
      [`${header}.${otherPayload}.${signature}`, 'bad-signature'],
      [byOther, 'unknown-key'],
      [await offlineFor(h, { product: 'maindeck' }), 'wrong-product'],
      [await offlineFor(h, { fid: 'lf_9' }), 'revoked-file'],
      [await offlineFor(h, { major: 1 }), 'upgrade'],
      [await offlineFor(h, { minMajor: 3 }), 'outdated'],
    ]
    for (const [content, error] of cases) {
      expect(await app.importLicenseFile(content), error).toEqual({ ok: false, error })
    }
    expect(h.getStored()?.licenseFile).toBeUndefined()
    expect(h.http.calls).toEqual([])
  })

  it('rejects when it cannot be saved, and a removal that cannot be saved leaves the stored file', async () => {
    const h = await harness()
    const stored = await offlineFor(h)
    h.setStored({ licenseFile: stored })
    const app = build(h)
    h.failWrites()
    await expect(app.importLicenseFile(await offlineFor(h, { fid: 'lf_3' }))).rejects.toThrow(/EBUSY/)
    await expect(app.removeLicenseFile()).rejects.toThrow(/EBUSY/)
    expect(h.getStored()?.licenseFile).toBe(stored)
  })

  it('refuses a configuration whose revokedLicenseFiles is not a list of texts', async () => {
    const h = await harness()
    expect(() => build(h, { revokedLicenseFiles: 'lf_1' })).toThrow(/revokedLicenseFiles/)
    expect(() => build(h, { revokedLicenseFiles: ['lf_1', 7] })).toThrow(/revokedLicenseFiles/)
  })

  it('keeps the denylist it was made with, whatever the app does to its list after', async () => {
    const h = await harness()
    h.setStored({ licenseFile: await offlineFor(h) })
    const revoked = ['lf_9']
    const app = build(h, { revokedLicenseFiles: revoked })
    revoked.push('lf_1')
    expect(await app.status()).toEqual(FILE_LICENSED)
  })
})

describe('a stored licence file that does not license this build', () => {
  it('is revoked-file once an update lists it, with whose it is, and no entitlements', async () => {
    const h = await harness()
    h.setStored({ licenseFile: await offlineFor(h, { ent: { cloud: true } }) })
    const app = build(h, { revokedLicenseFiles: ['lf_0', 'lf_1'] })
    expect(await app.status()).toEqual({ state: 'invalid', reason: 'revoked-file', key: KEY, source: 'file', licensedTo: ADA })
    expect(await app.has('cloud')).toBe(false)
  })

  it('is upgrade on a build newer than it covers, and outdated on one older', async () => {
    const h = await harness()
    h.setStored({ licenseFile: await offlineFor(h, { minMajor: 2, major: 3 }) })
    expect(await build(h, { major: 4 }).status()).toEqual({ state: 'invalid', reason: 'upgrade', key: KEY, source: 'file', licensedTo: ADA })
    expect(await build(h, { major: 1 }).status()).toEqual({ state: 'invalid', reason: 'outdated', key: KEY, source: 'file', licensedTo: ADA })
  })

  it('reads a stored value that is not text as tampered, and a null one as none, never rejecting', async () => {
    const h = await harness()
    const app = build(h)
    h.setStored(storedFile(42))
    expect(await app.status()).toEqual({ state: 'invalid', reason: 'tampered', source: 'file' })
    h.setStored(storedFile(null))
    expect(await app.status()).toEqual({ state: 'unlicensed' })
  })

  it('is tampered when the stored token was edited, or is a key file, which is never stored', async () => {
    const h = await harness()
    const [header, , signature] = (await offlineFor(h)).split('.') as [string, string, string]
    const app = build(h)
    h.setStored({ licenseFile: `${header}.${(await offlineFor(h, { major: 9 })).split('.')[1]}.${signature}` })
    expect(await app.status()).toEqual({ state: 'invalid', reason: 'tampered', source: 'file' })
    h.setStored({ licenseFile: await keyFileFor(h) })
    expect(await app.status()).toEqual({ state: 'invalid', reason: 'tampered', source: 'file' })
  })

  it('survives a key rotation while the build carries the key that signed it, and is unknown-key on one that dropped it', async () => {
    const h = await harness()
    const next = await generateKeyPair()
    h.setStored({ licenseFile: await offlineFor(h) })
    // A build after the switch: the new key signs, the old one is kept because it signed files.
    expect(await build(h, { publicJwks: [next.publicJwk, h.publicJwk] }).status()).toEqual(FILE_LICENSED)
    // A build that dropped it (a leaked key): the file must be signed again.
    expect(await build(h, { publicJwks: [next.publicJwk] }).status()).toEqual({ state: 'invalid', reason: 'unknown-key', source: 'file' })
  })
})
