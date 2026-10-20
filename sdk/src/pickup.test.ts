import { describe, it, expect } from 'vitest'
import { harness, NOW } from './license.fixture.js'
import { PICKUP_KEYS_KEEP_MS, chosenKey, covers, pickedKeysOf, pickupAsk, pickupRefusal } from './pickup.js'
import type { PickedKey } from './types.js'

/**
 * Key pickup (the SDK contract, section 13): what `pickUp` sends and answers,
 * and the key `restoreByEmail` activates. The rules each piece follows are
 * pinned by the conformance vectors; these are the calls around them.
 */

const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
const MONTH = 30 * 24 * 3600
const ADDRESS = 'Mara@Studio.example'

/** A picked key as a confirm's answer reads, with what a test leaves out filled in. */
function picked(over: Partial<PickedKey> = {}): PickedKey {
  return {
    key: KEY,
    model: 'perpetual',
    modelName: 'Single',
    state: 'active',
    entitlements: {},
    expiresAt: null,
    versions: { minMajor: 1, maxMajor: 1, upgradeUntil: null },
    deviceLimit: 1,
    activeDevices: 0,
    held: false,
    ...over,
  }
}

describe('pickUp(email)', () => {
  it('asks for a code with the address trimmed, and answers sent', async () => {
    const h = await harness()
    h.http.on('pickup', () => ({ status: 200, json: { ok: true } }))
    expect(await h.license.pickUp('  Mara@Studio.example\n')).toEqual({ ok: true, sent: true })
    expect(h.http.bodyOf('pickup')).toEqual({ email: ADDRESS })
  })

  it('refuses a blank address before it asks, and answers each refusal as its error', async () => {
    const h = await harness()
    expect(await h.license.pickUp('   ')).toEqual({ ok: false, error: 'invalid-email' })
    expect(h.http.count('pickup')).toBe(0)
    h.http.on('pickup', () => ({ status: 403, json: { error: 'pickup-disabled' } }))
    expect(await h.license.pickUp(ADDRESS)).toEqual({ ok: false, error: 'pickup-disabled' })
    h.http.on('pickup', () => ({ status: 429, json: { error: 'rate-limited', retryAfter: 120 } }))
    expect(await h.license.pickUp(ADDRESS)).toEqual({ ok: false, error: 'too-many-attempts', retryAfter: 120 })
    h.http.fail = true
    expect(await h.license.pickUp(ADDRESS)).toEqual({ ok: false, error: 'network' })
  })

  it('writes nothing', async () => {
    const h = await harness()
    h.http.on('pickup', () => ({ status: 200, json: { ok: true } }))
    await h.license.pickUp(ADDRESS)
    expect(h.writes()).toBe(0)
  })
})

describe('pickUp(email, code)', () => {
  it('sends the address, the code and this device’s fingerprints, and answers the keys as read', async () => {
    const h = await harness()
    h.http.on('confirm', () => ({ status: 200, json: { keys: [{ key: KEY, model: 'perpetual', modelName: 'Single', state: 'active', held: true }] } }))
    const res = await h.license.pickUp(ADDRESS, ' 123 456 ')
    expect(res).toMatchObject({ ok: true, keys: [{ key: KEY, modelName: 'Single', held: true }] })
    const body = h.http.bodyOf('confirm') as { email: string; code: string; fingerprints?: string[] }
    expect(body).toMatchObject({ email: ADDRESS, code: '123456' })
    expect(body.fingerprints?.length).toBeGreaterThan(0)
  })

  it('sends no fingerprints for a product whose devices are not held', async () => {
    const h = await harness(null, { deviceHold: false })
    h.http.on('confirm', () => ({ status: 200, json: { keys: [] } }))
    await h.license.pickUp(ADDRESS, '123456')
    expect(h.http.bodyOf('confirm')).not.toHaveProperty('fingerprints')
  })

  it('refuses a code that is not six digits before it asks, costing the address no try', async () => {
    const h = await harness()
    expect(await h.license.pickUp(ADDRESS, '12345')).toEqual({ ok: false, error: 'wrong-code' })
    expect(await h.license.pickUp(ADDRESS, '')).toEqual({ ok: false, error: 'wrong-code' })
    expect(h.http.count('confirm')).toBe(0)
  })

  it('answers the server’s words, and a 200 that is no pickup answer as network', async () => {
    const h = await harness()
    for (const word of ['wrong-code', 'code-expired', 'pickup-disabled'] as const) {
      h.http.on('confirm', () => ({ status: 403, json: { error: word } }))
      expect(await h.license.pickUp(ADDRESS, '123456')).toEqual({ ok: false, error: word })
    }
    h.http.on('confirm', () => ({ status: 429, json: { error: 'too-many-attempts', retryAfter: 3000 } }))
    expect(await h.license.pickUp(ADDRESS, '123456')).toEqual({ ok: false, error: 'too-many-attempts', retryAfter: 3000 })
    h.http.on('confirm', () => ({ status: 200, json: { ok: true } }))
    expect(await h.license.pickUp(ADDRESS, '123456')).toEqual({ ok: false, error: 'network' })
  })
})

describe('restoreByEmail', () => {
  it('confirms, then activates the key that fits with the address, and stores the activation, never the code', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked()] } }))
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ key: KEY, email: ADDRESS })
    expect(h.http.bodyOf('activate')).not.toHaveProperty('code')
    expect(JSON.stringify(h.getStored())).not.toMatch(/studio|123456/i)
    expect((await h.license.status()).state).toBe('licensed')
  })

  it('activates a code-locked key with the code the pickup handed back', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked({ activationCode: '654321' })] } }))
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: true })
    expect(h.http.bodyOf('activate')).toMatchObject({ key: KEY, email: ADDRESS, code: '654321' })
  })

  it('answers no-key for an address with none, and upgrade for keys of an older major, activating nothing', async () => {
    const h = await harness(null, { major: 2 })
    h.http.on('confirm', () => ({ status: 200, json: { keys: [] } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: false, error: 'no-key' })
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked()] } }))
    expect(await h.license.restoreByEmail(ADDRESS, '654321')).toEqual({ ok: false, error: 'upgrade' })
    expect(h.http.count('activate')).toBe(0)
  })

  it('keeps the confirmed keys in memory, so a restore after a failed activation, or after pickUp(email, code), asks once', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked()] } }))
    h.http.on('activate', () => ({ status: 503, json: { error: 'unavailable' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: false, error: 'network' })
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.restoreByEmail(ADDRESS, ' 123 456 ')).toEqual({ ok: true })
    expect(h.http.count('confirm')).toBe(1)
    // Done with once activated: the same pair asks again.
    expect((await h.license.pickUp(ADDRESS, '123456')).ok).toBe(true)
    expect(h.http.count('confirm')).toBe(2)
  })

  it('keeps nothing of a refused confirm, and a refusal for another pair leaves the kept keys alone', async () => {
    const h = await harness()
    h.http.on('confirm', () => ({ status: 403, json: { error: 'wrong-code' } }))
    await h.license.pickUp(ADDRESS, '111111')
    await h.license.pickUp(ADDRESS, '111111')
    expect(h.http.count('confirm')).toBe(2)
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked()] } }))
    await h.license.pickUp(ADDRESS, '123456')
    h.http.on('confirm', () => ({ status: 403, json: { error: 'wrong-code' } }))
    await h.license.pickUp(ADDRESS, '222222')
    expect(await h.license.pickUp(ADDRESS, '123456')).toMatchObject({ ok: true, keys: [{ key: KEY }] })
    expect(h.http.count('confirm')).toBe(4)
  })

  it('asks again with another code, and once the keys are ten minutes old', async () => {
    const h = await harness()
    h.http.on('confirm', () => ({ status: 200, json: { keys: [] } }))
    await h.license.pickUp(ADDRESS, '123456')
    await h.license.pickUp(ADDRESS, '654321')
    expect(h.http.count('confirm')).toBe(2)
    await h.license.pickUp(ADDRESS, '654321')
    expect(h.http.count('confirm')).toBe(2)
    h.setClock(NOW + PICKUP_KEYS_KEEP_MS)
    await h.license.pickUp(ADDRESS, '654321')
    expect(h.http.count('confirm')).toBe(3)
  })

  it('leaves the licence this device holds as it was when a restore fails', async () => {
    const h = await harness()
    const lease = await h.sign(KEY, 'perpetual', MONTH)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    expect(await h.license.activate(KEY)).toEqual({ ok: true })
    const before = JSON.stringify(h.getStored())
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked({ key: 'SLUICE-OTHR-BBBB-CCCC-DDDD' })] } }))
    h.http.on('activate', () => ({ status: 409, json: { error: 'limit' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: false, error: 'limit' })
    h.http.fail = true
    expect(await h.license.restoreByEmail(ADDRESS, '654321')).toEqual({ ok: false, error: 'network' })
    expect(JSON.stringify(h.getStored())).toBe(before)
  })

  it('answers a pickup refusal, and an activation’s, as they come', async () => {
    const h = await harness()
    h.http.on('confirm', () => ({ status: 403, json: { error: 'code-expired' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: false, error: 'code-expired' })
    h.http.on('confirm', () => ({ status: 200, json: { keys: [picked()] } }))
    h.http.on('activate', () => ({ status: 409, json: { error: 'limit' } }))
    expect(await h.license.restoreByEmail(ADDRESS, '123456')).toEqual({ ok: false, error: 'limit' })
  })
})

describe('the pieces', () => {
  it('asks for a code with an address alone, and confirms with a code', () => {
    expect(pickupAsk(ADDRESS, null)).toEqual({ send: { email: ADDRESS } })
    expect(pickupAsk(ADDRESS, '123456')).toEqual({ send: { email: ADDRESS, code: '123456' } })
    expect(pickupAsk('', '123456')).toEqual({ refused: 'invalid-email' })
  })

  it('reads a refusal leniently', () => {
    expect(pickupRefusal(null)).toEqual({ error: 'network' })
    expect(pickupRefusal({ error: 'unavailable', retryAfter: 60 })).toEqual({ error: 'try-again', retryAfter: 60 })
    expect(pickupRefusal({ error: 'wrong-code', retryAfter: 60 })).toEqual({ error: 'wrong-code' })
    expect(pickupRefusal({ error: 'too-many-attempts', retryAfter: 1.5 })).toEqual({ error: 'too-many-attempts' })
  })

  it('reads a confirm’s keys leniently, and none from what is no answer', () => {
    expect(pickedKeysOf({ keys: 'no' })).toBeNull()
    expect(pickedKeysOf([])).toBeNull()
    expect(pickedKeysOf({ keys: [{ key: '' }, 7, { key: KEY, held: 'yes', activationCode: '12345' }] })).toEqual([
      { key: KEY, model: '', modelName: null, state: '', entitlements: {}, expiresAt: null, versions: null, deviceLimit: 0, activeDevices: 0, held: false },
    ])
  })

  it('judges a key’s versions as the server does', () => {
    expect(covers(null, 9, NOW)).toBe(true)
    expect(covers({ minMajor: 2, maxMajor: 3, upgradeUntil: null }, 1, NOW)).toBe(false)
    expect(covers({ minMajor: 2, maxMajor: 3, upgradeUntil: null }, 4, NOW)).toBe(false)
    expect(covers({ minMajor: 2, maxMajor: 3, upgradeUntil: NOW + 1 }, 4, NOW)).toBe(true)
    expect(covers({ minMajor: 2, maxMajor: null, upgradeUntil: null }, 40, NOW)).toBe(true)
  })

  it('chooses the key this device holds, then one with a free seat, then the first', () => {
    const full = picked({ key: 'A', activeDevices: 1 })
    const free = picked({ key: 'B' })
    const held = picked({ key: 'C', activeDevices: 1, held: true })
    expect(chosenKey([full, free, held], 1, NOW)).toEqual({ index: 2 })
    expect(chosenKey([full, free], 1, NOW)).toEqual({ index: 1 })
    expect(chosenKey([full, picked({ key: 'D', activeDevices: 1 })], 1, NOW)).toEqual({ index: 0 })
    expect(chosenKey([picked({ versions: { minMajor: 3, maxMajor: null, upgradeUntil: null } })], 1, NOW)).toEqual({ refused: 'outdated' })
  })
})
