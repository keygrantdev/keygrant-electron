/**
 * What the metered-uses suites share: a key's lease carrying meters, a harness holding it, and the server's
 * answers to a `use`. Test support only: never exported from the package, and left out of its declarations.
 */
import { signLease, type SignableMeters } from '@keygrant/shared'
import { NOW, PRODUCT, harness, type Harness } from './license.fixture.js'
import type { SpendEntry, StoredState } from './types.js'

export const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
export const MONTH = 30 * 24 * 3600

/** A key with 100 exports, 90 of them left, a device allowance of 10, and 5 renders a billing period. */
export const METERS: SignableMeters = {
  exports: { left: 90, total: 100, offline: 10 },
  renders: { left: 5, total: 5, offline: 0, resets: true },
}

/** A licence lease for KEY on act_1, covering majors 1 to 3, with `met`. */
export function meteredLease(
  h: Harness,
  met: SignableMeters | null = METERS,
  opts: { ttlSeconds?: number; now?: number; aid?: string; sub?: string } = {},
): Promise<string> {
  const { ttlSeconds = MONTH, now = NOW, aid = 'act_1', sub = KEY } = opts
  const input = { sub, product: PRODUCT, aid, model: 'subscription' as const, lim: 3, major: 3, ent: {}, ttlSeconds }
  return signLease(met === null ? input : { ...input, met }, h.signingKey, now)
}

/**
 * A key's lease whose `met` is any JSON, signed by hand: the signer refuses what a verifier still reads
 * (a meter named `__proto__`, a figure that is not whole), so a lease the server would never sign is made here.
 */
export async function rawLease(h: Harness, met: unknown, over: Record<string, unknown> = {}): Promise<string> {
  const enc = new TextEncoder()
  const part = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
  const iat = NOW / 1000
  const claims = { iss: 'keygrant', sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual', lim: 3, major: 3, ent: {}, met, iat, exp: iat + MONTH, ...over }
  const input = `${part(enc.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })))}.${part(enc.encode(JSON.stringify(claims)))}`
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, h.signingKey, enc.encode(input)))
  return `${input}.${part(signature)}`
}

/**
 * An offline licence file for the harness's product carrying a `met` claim: the signer would refuse it, a
 * verifier ignores it. Signed by hand over the file's own header and claims.
 */
export async function offlineFileWithMet(h: Harness, met: unknown): Promise<string> {
  const { offlineFor } = await import('./license-file.fixture.js')
  const [header = '', payload = ''] = (await offlineFor(h)).split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  const input = `${header}.${Buffer.from(JSON.stringify({ ...claims, met })).toString('base64url')}`
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, h.signingKey, new TextEncoder().encode(input)))
  return `${input}.${Buffer.from(signature).toString('base64url')}`
}

/** A harness whose storage holds KEY activated on act_1 with a lease carrying `met`, and `state` beside it. */
export async function holding(
  met: SignableMeters | null = METERS,
  state: StoredState = {},
  opts: Parameters<typeof harness>[1] = {},
): Promise<Harness & { lease: string }> {
  const h = await harness(null, opts)
  const lease = await meteredLease(h, met)
  h.setStored({ key: KEY, activationId: 'act_1', lease, ...state })
  return Object.assign(h, { lease })
}

/** The server's answer to a spend that landed: what is left of `exports` now, at `at`. */
export const spent = (left: number, at = NOW): { status: number; json: unknown } => ({
  status: 200,
  json: { spent: true, meters: { exports: { left, total: 100, offline: 10 } }, at },
})

/** The journal's entry for a spend, `kind` and all. */
export const entry = (over: Partial<SpendEntry> = {}): SpendEntry => ({ id: 'AAAAAAAAAAAAAAAAAAAAAA', meter: 'exports', n: 1, at: NOW, kind: 'offline', ...over })

/** The body of the `nth` (from 0) `use` request. */
export function useBody(h: Harness, nth = 0): Record<string, unknown> {
  const call = h.http.calls.filter((c) => c.action === 'use')[nth]
  if (!call) throw new Error(`expected use request ${nth}`)
  return call.body as Record<string, unknown>
}

/** The journal as stored now. */
export const journalOf = (h: Harness): SpendEntry[] => h.getStored()?.spends ?? []
