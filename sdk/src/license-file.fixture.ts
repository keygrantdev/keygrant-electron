/**
 * What the licence-file suites share: Ada's offline file and key file for the
 * harness's product, signed by its key, a lease for the same key, and the app
 * rebuilt with a configuration of the suite's. Test support only: never
 * exported from the package, and left out of its declarations.
 */
import { keyId, signLease, signLicenseFile, type LicenseFileInput } from '@keygrant/shared'
import { License } from './license.js'
import type { StoredState } from './types.js'
import { NOW, PRODUCT, type Harness } from './license.fixture.js'

export const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
export const DAY_S = 86_400
export const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' }

type OfflineInput = Extract<LicenseFileInput, { kind: 'offline' }>
type KeyFileInput = Extract<LicenseFileInput, { kind: 'key' }>

/** Ada's offline file: majors 1 to 3. */
export const OFFLINE: OfflineInput = { kind: 'offline', fid: 'lf_1', sub: KEY, product: PRODUCT, ...ADA, major: 3 }
/** Ada's key file, its key written in lower case (the SDK sends it as a typed key, normalised). */
export const KEY_FILE: KeyFileInput = { kind: 'key', fid: 'lf_2', sub: KEY.toLowerCase(), product: PRODUCT, email: ADA.email }
/** What status() gives for the OFFLINE file. */
export const FILE_LICENSED = { state: 'licensed', key: KEY, source: 'file', licensedTo: ADA }

/** The OFFLINE file with `over`, signed by the harness's key and naming it. */
export async function offlineFor(h: Harness, over: Partial<OfflineInput> = {}): Promise<string> {
  return signLicenseFile({ ...OFFLINE, ...over }, h.signingKey, await keyId(h.publicJwk), NOW)
}

/** The KEY_FILE with `over`, signed by the harness's key and naming it. */
export async function keyFileFor(h: Harness, over: Partial<KeyFileInput> = {}): Promise<string> {
  return signLicenseFile({ ...KEY_FILE, ...over }, h.signingKey, await keyId(h.publicJwk), NOW)
}

/** A licence lease for KEY on act_1, covering majors 1 to 3, for `ttlSeconds` (thirty days), with `upgradeUntil` when given. */
export function leaseFor(h: Harness, opts: { ttlSeconds?: number; upgradeUntil?: number; now?: number } = {}): Promise<string> {
  const { ttlSeconds = 30 * DAY_S, upgradeUntil, now = NOW } = opts
  const input = { sub: KEY, product: PRODUCT, aid: 'act_1', model: 'perpetual' as const, lim: 3, major: 3, ent: {}, ttlSeconds }
  return signLease(upgradeUntil === undefined ? input : { ...input, upgradeUntil }, h.signingKey, now)
}

/** The configuration a suite gives the app; `revokedLicenseFiles` as any value, to try one the SDK refuses. */
export interface FileAppConfig {
  publicJwks?: JsonWebKey[]
  major?: number
  revokedLicenseFiles?: unknown
}

/** The harness's app, rebuilt with `config` (its storage, clock, device and server kept), as major 2 unless said. */
export function build(h: Harness, config: FileAppConfig = {}): License {
  const keys = config.publicJwks ? { publicJwks: config.publicJwks } : { publicJwk: h.publicJwk }
  const revoked = config.revokedLicenseFiles === undefined ? {} : { revokedLicenseFiles: config.revokedLicenseFiles as readonly string[] }
  return new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', major: config.major ?? 2, ...keys, ...revoked, adapters: h.adapters })
}

/** A stored state whose licence file is any JSON value, as another program might have written it. */
export function storedFile(value: unknown, rest: StoredState = {}): StoredState {
  return { ...rest, ...(JSON.parse(JSON.stringify({ licenseFile: value })) as StoredState) }
}
