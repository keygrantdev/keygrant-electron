import { describe, it, expect } from 'vitest'
import { MAX_EMAIL, enteredCode, enteredEmail, mapServerError, typedFor } from './wire.js'
import { licenseFileText } from '@keygrant/shared'
import { harness } from './license.fixture.js'
import { build, keyFileFor } from './license-file.fixture.js'

/**
 * User-locked keys (the SDK contract, section 11): what `activate(key,
 * { email, code })` sends, and how each word the server refuses with comes back.
 */

const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
const MONTH = 30 * 24 * 3600

describe('activate with an address and a code', () => {
  it('sends what the person typed, trimmed, beside the key, and nothing when they typed none', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))

    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('email')
    expect(h.http.bodyOf('activate')).not.toHaveProperty('code')

    await h.license.activate(KEY, { email: '  Mara@Studio.example\n', code: ' 123 456 ' })
    const sent = h.http.calls.filter((c) => c.action === 'activate')
    expect(sent[1]?.body).toMatchObject({ key: KEY, email: 'Mara@Studio.example', code: '123456' })
  })

  it('takes null options, as an app that passes none may, and sends nothing of them', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'user-email-required' } }))
    expect(await h.license.activate(KEY, null)).toEqual({ ok: false, error: 'user-email-required' })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('email')
    expect(await h.license.importLicenseFile('not a file', null)).toEqual({ ok: false, error: 'malformed' })
  })

  it('treats a blank address or code as none, and sends the one it has', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'user-email-required' } }))
    await h.license.activate(KEY, { email: '   ', code: '' })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('email')
    expect(h.http.bodyOf('activate')).not.toHaveProperty('code')
    const other = await harness()
    other.http.on('activate', () => ({ status: 403, json: { error: 'user-email-required' } }))
    await other.license.activate(KEY, { email: 'mara@studio.example' })
    expect(other.http.bodyOf('activate')).toMatchObject({ email: 'mara@studio.example' })
    expect(other.http.bodyOf('activate')).not.toHaveProperty('code')
  })

  it('answers each word of the server as its own error, so an app can ask for the address, then the code', async () => {
    const words = ['user-email-required', 'user-email-mismatch', 'user-code-required', 'user-code-invalid', 'too-many-codes', 'too-many-attempts', 'try-again'] as const
    for (const word of words) {
      const h = await harness()
      h.http.on('activate', () => ({ status: word === 'try-again' ? 503 : word.startsWith('too-many') ? 429 : 403, json: { error: word } }))
      expect(await h.license.activate(KEY, { email: 'mara@studio.example' })).toEqual({ ok: false, error: word })
    }
  })

  it('stores nothing about the address or the code, or about a refusal', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'user-code-required' } }))
    await h.license.activate(KEY, { email: 'mara@studio.example', code: '123456' })
    expect(h.getStored()).toBeNull()
    expect(h.writes()).toBe(0)
  })

  it('stores the activation as ever once the lease comes, and nothing of what was typed', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY, { email: 'mara@studio.example', code: '123456' })).toEqual({ ok: true })
    const stored = JSON.stringify(h.getStored())
    expect(stored).toContain(KEY)
    expect(stored).not.toMatch(/studio|123456/)
  })

  it('refuses an address longer than any, and a code that is not six digits, before it asks the server', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'user-email-required' } }))
    expect(await h.license.activate(KEY, { email: `${'a'.repeat(MAX_EMAIL)}@b.example` })).toEqual({ ok: false, error: 'user-email-mismatch' })
    expect(await h.license.activate(KEY, { email: 'a@b.example', code: '12345' })).toEqual({ ok: false, error: 'user-code-invalid' })
    expect(await h.license.activate(KEY, { email: 'a@b.example', code: '1234567' })).toEqual({ ok: false, error: 'user-code-invalid' })
    expect(await h.license.activate(KEY, { email: 'a@b.example', code: 'abcdef' })).toEqual({ ok: false, error: 'user-code-invalid' })
    expect(h.http.count('activate')).toBe(0)
    // The address is judged first, as the key is before both.
    expect(await h.license.activate(KEY, { email: 'x'.repeat(300), code: 'nope' })).toEqual({ ok: false, error: 'user-email-mismatch' })
    expect(await h.license.activate('', { email: 'x'.repeat(300) })).toEqual({ ok: false, error: 'invalid-key' })
  })

  it('does not change what a failure to reach the server is: a network error is still `network`', async () => {
    const h = await harness()
    h.http.fail = true
    expect(await h.license.activate(KEY, { email: 'mara@studio.example' })).toEqual({ ok: false, error: 'network' })
  })

  it('is asked of a key file’s key too, with the same address and code, and its answers come back as activate’s', async () => {
    const h = await harness()
    h.http.on('activate', () => ({ status: 403, json: { error: 'user-code-required' } }))
    const app = build(h)
    const file = licenseFileText(await keyFileFor(h))
    expect(await app.importLicenseFile(file, { email: ' Ada@Example.com ', code: '123 456' })).toEqual({ ok: false, error: 'user-code-required' })
    expect(h.http.bodyOf('activate')).toMatchObject({ key: KEY, email: 'Ada@Example.com', code: '123456' })
    // With no options it sends neither, as before, and null is none.
    expect(await app.importLicenseFile(file)).toEqual({ ok: false, error: 'user-code-required' })
    expect(await app.importLicenseFile(file, null)).toEqual({ ok: false, error: 'user-code-required' })
    for (const call of h.http.calls.slice(1)) expect(call.body).not.toHaveProperty('email')
    // Nothing of it is stored.
    expect(h.getStored()).toBeNull()
  })

  it('refuses a file that is no licence file before any key is asked for, whatever options come with it', async () => {
    const h = await harness()
    expect(await h.license.importLicenseFile('not a file', { email: 'mara@studio.example' })).toEqual({ ok: false, error: 'malformed' })
    expect(h.http.count('activate')).toBe(0)
  })

  it('sends neither to validate, deactivate or a trial, even after an activation that carried them', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('validate', () => ({ status: 200, json: { lease } }))
    h.http.on('deactivate', () => ({ status: 200, json: {} }))
    h.http.on('trial', () => ({ status: 404, json: { error: 'unknown' } }))
    expect(await h.license.activate(KEY, { email: 'mara@studio.example', code: '123456' })).toEqual({ ok: true })
    await h.license.refresh()
    await h.license.deactivate()
    await h.license.startTrial()
    for (const call of h.http.calls.filter((c) => c.action !== 'activate')) {
      expect(call.body, call.action).not.toHaveProperty('email')
      expect(call.body, call.action).not.toHaveProperty('code')
    }
    expect(h.http.count('validate')).toBeGreaterThan(0)
    expect(h.http.count('deactivate')).toBe(1)
    expect(h.http.count('trial')).toBeGreaterThan(0)
  })

  it('answers a rate limit or an outage that is not a lock’s word as network, as it always did', async () => {
    for (const [status, error] of [[429, 'rate-limited'], [503, 'unavailable'], [500, 'internal']] as const) {
      const h = await harness()
      h.http.on('activate', () => ({ status, json: { error } }))
      expect(await h.license.activate(KEY, { email: 'mara@studio.example' }), `${status} ${error}`).toEqual({ ok: false, error: 'network' })
    }
  })
})

describe('what a person typed', () => {
  it('trims an address with the whitespace a paste carries, and calls a blank none', () => {
    expect(enteredEmail('  Mara@Studio.example \r\n')).toEqual({ send: 'Mara@Studio.example' })
    expect(enteredEmail('\uFEFFmara@studio.example')).toEqual({ send: 'mara@studio.example' })
    expect([enteredEmail(''), enteredEmail('  \t'), enteredEmail(undefined)]).toEqual([{ send: null }, { send: null }, { send: null }])
  })

  it('keeps an address of exactly the longest and refuses a longer one', () => {
    expect(enteredEmail('a'.repeat(MAX_EMAIL))).toEqual({ send: 'a'.repeat(MAX_EMAIL) })
    expect(enteredEmail('a'.repeat(MAX_EMAIL + 1))).toEqual({ tooLong: true })
    // Measured after the trim.
    expect(enteredEmail(` ${'a'.repeat(MAX_EMAIL)} `)).toEqual({ send: 'a'.repeat(MAX_EMAIL) })
  })

  it('takes six digits however they were typed, with spaces between, and nothing else', () => {
    expect(enteredCode('123456')).toEqual({ send: '123456' })
    expect(enteredCode(' 123 456\n')).toEqual({ send: '123456' })
    expect(enteredCode('1 2 3 4 5 6')).toEqual({ send: '123456' })
    expect(enteredCode('000042')).toEqual({ send: '000042' })
    for (const bad of ['12345', '1234567', '12345a', '123-456', '123\t456', '１２３４５６', '١٢٣٤٥٦', '+12345', '1e5555']) {
      expect(enteredCode(bad), bad).toEqual({ malformed: true })
    }
    expect([enteredCode(''), enteredCode('   '), enteredCode(undefined)]).toEqual([{ send: null }, { send: null }, { send: null }])
  })

  it('reads what a JavaScript caller may hand over: a number as its digits, anything else that is not text as none', () => {
    const odd = (value: unknown) => value as string
    expect(enteredCode(odd(123456))).toEqual({ send: '123456' })
    // A code that began with a zero, kept as a number, is six digits again.
    expect(enteredCode(odd(12345))).toEqual({ send: '012345' })
    expect(enteredCode(odd(42))).toEqual({ send: '000042' })
    expect(enteredCode(odd(0))).toEqual({ send: '000000' })
    // Any other value that is not text is none, a number out of the code's range included, and an address is never read from a number.
    for (const value of [-1, 1_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [], true, Symbol.iterator]) {
      expect(enteredCode(odd(value)), String(String(value))).toEqual({ send: null })
      expect(enteredEmail(odd(value)), String(String(value))).toEqual({ send: null })
    }
    expect(enteredEmail(odd(7))).toEqual({ send: null })
    expect(typedFor({ email: odd(7), code: odd({}) })).toEqual({ send: {} })
  })

  it('judges the address before the code, and sends only what there is', () => {
    expect(typedFor({})).toEqual({ send: {} })
    expect(typedFor({ email: ' a@b.example ', code: '1 2 3 4 5 6' })).toEqual({ send: { email: 'a@b.example', code: '123456' } })
    expect(typedFor({ code: '123456' })).toEqual({ send: { code: '123456' } })
    expect(typedFor({ email: 'x'.repeat(300), code: 'no' })).toEqual({ refused: 'user-email-mismatch' })
    expect(typedFor({ email: 'a@b.example', code: 'no' })).toEqual({ refused: 'user-code-invalid' })
  })

  it('maps the words of a user lock to errors and any other new word to network', () => {
    expect(mapServerError('user-email-required')).toBe('user-email-required')
    expect(mapServerError('try-again')).toBe('try-again')
    expect(mapServerError('user-something-new')).toBe('network')
    expect(mapServerError('rate-limited')).toBe('network')
  })
})

