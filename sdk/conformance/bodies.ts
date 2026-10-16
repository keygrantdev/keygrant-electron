/**
 * The requests a `License` sends that carry a report of unsynced spends (the SDK contract, 12.2), captured from
 * the real thing over a fake HTTP adapter: a `use`, a `validate` and a `deactivate`, each as it was sent. Written to
 * `wire-bodies.json`, which the reference's suite holds to what a `License` sends today and the worker's own suite
 * parses with its schemas, so the two cannot drift apart without a test saying so. The only random member, the
 * spend's id, is written as a fixed one.
 */
import { importSigningKey, signLease } from '@keygrant/shared'
import { License } from '../src/license.js'
import { NOW, PRODUCT, harness } from '../src/license.fixture.js'
import type { SpendEntry } from '../src/meter-types.js'
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from './vectors/common.js'

const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
const SPEND_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const HOUR = 3_600_000

/** What a device out of reach left behind: an offline spend, an unanswered one and a void, all opened two hours ago. */
const JOURNAL: SpendEntry[] = [
  { id: 'offlineoffline0000001', meter: 'exports', n: 3, at: NOW - 2 * HOUR, kind: 'offline' },
  { id: 'unansweredunanswered2', meter: 'renders', n: 1, at: NOW - 2 * HOUR + 1, kind: 'unanswered' },
  { id: 'voidvoidvoidvoid00003', meter: 'exports', n: 2, at: NOW - 2 * HOUR + 2, kind: 'void' },
]

export async function wireBodies() {
  const h = await harness()
  const met = { exports: { left: 90, total: 100, offline: 10 }, renders: { left: 5, total: 5, offline: 0, resets: true as const } }
  const input = { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'subscription' as const, lim: 3, major: 3, ent: {}, met, ttlSeconds: 30 * 86_400 }
  const lease = await signLease(input, await importSigningKey(TEST_PRIVATE_JWK as JsonWebKey), NOW)
  h.setStored({ key: KEY, activationId: 'act_1', lease, spends: JOURNAL })
  const app = new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk: TEST_PUBLIC_JWK as JsonWebKey, major: 3, adapters: h.adapters })
  // Answers that confirm nothing, so the journal is still there for the next request.
  h.http.on('use', () => ({ status: 200, json: { spent: true, meters: met, at: NOW } }))
  h.http.on('validate', () => ({ status: 200, json: {} }))
  h.http.on('deactivate', () => ({ status: 200, json: {} }))
  await app.use('exports', 2)
  await app.refresh()
  await app.deactivate()
  const use = h.http.bodyOf('use') as Record<string, unknown>
  // The contract's spend id (16 bytes in base64url with no padding: 22 characters), checked before the id is written as a
  // fixed one: a License that sent any other fails here, not later in a test over the fixed one.
  if (typeof use.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(use.id)) throw new Error(`the use request id is not a spend id of the contract: ${String(use.id)}`)
  return {
    $comment:
      'The bodies a KeyGrant Electron SDK License sends with a report of unsynced spends: a use (its spend id written as a fixed one), a validate and a deactivate, captured over a fake HTTP adapter. The worker parses them with its schemas.',
    use: { ...use, id: SPEND_ID },
    validate: h.http.bodyOf('validate'),
    deactivate: h.http.bodyOf('deactivate'),
  }
}
