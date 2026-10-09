import { describe, it, expect } from 'vitest'
import { signLease } from '@keygrant/shared'
import { majorOf } from './offline.js'
import { NOW, PRODUCT, harness, type Harness } from './license.fixture.js'

/** A perpetual lease for KEY on act_1, covering majors 1 (no lowest named) to `major`. */
function leaseUpTo(h: Harness, major: number): Promise<string> {
  const claims = { sub: 'KEY', product: PRODUCT, aid: 'act_1', model: 'perpetual' as const, lim: 3, major, ent: {}, ttlSeconds: 30 * 86_400 }
  return signLease(claims, h.signingKey, NOW)
}

describe('majorOf: what no vector can carry', () => {
  // The rest of majorOf is the majors vectors, replayed by conformance.test.ts.
  it('reads a value that is not a finite number as 1', () => {
    expect([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(majorOf)).toEqual([1, 1, 1])
  })
})

describe('a 0.x build (major 0)', () => {
  it('is licensed offline by a lease for major 1, not refused as outdated', async () => {
    const h = await harness(null, { major: 0 })
    h.setStored({ key: 'KEY', activationId: 'act_1', lease: await leaseUpTo(h, 1), checkedMajor: 1, lastSeen: NOW })
    h.http.fail = true
    expect(await h.license.status()).toEqual({ state: 'licensed', key: 'KEY' })
  })

  it('sends major 1 with its activation and its validate, as the server reads it', async () => {
    const h = await harness(null, { major: 0 })
    const lease = await leaseUpTo(h, 1)
    h.http.on('activate', () => ({ status: 200, json: { lease, activationId: 'act_1' } }))
    h.http.on('validate', () => ({ status: 200, json: { lease } }))
    expect(await h.license.activate('KEY')).toEqual({ ok: true })
    expect(await h.license.refresh()).toEqual({ state: 'licensed', key: 'KEY' })
    expect(h.http.bodyOf('activate')).toMatchObject({ major: 1 })
    expect(h.http.bodyOf('validate')).toMatchObject({ major: 1 })
    expect(h.getStored()).toMatchObject({ checkedMajor: 1 })
  })

  it('sends a fractional major as its whole number', async () => {
    const h = await harness(null, { major: 2.7 })
    h.http.on('activate', () => ({ status: 403, json: { error: 'limit' } }))
    await h.license.activate('KEY')
    expect(h.http.bodyOf('activate')).toMatchObject({ major: 2 })
  })
})
