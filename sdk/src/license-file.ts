/**
 * What the SDK decides of a licence file offline, once verified: whether
 * one may be taken by this app (`checkLicenseFile`), and the status a stored
 * offline file gives (`licenseFileStatus`). Pure, so every SDK reproduces them
 * from the conformance vectors.
 */
import type { LicenseFileClaims, LicenseFileKind, LicenseFileVerifyResult } from '@keygrant/shared'
import type { LicensedTo, LicenseFileError, LicenseStatus } from './types.js'
import { entitled } from './wire.js'

/** What a licence file says about this app, offline. */
export type LicenseFileCheck =
  | { ok: true; kind: LicenseFileKind; test: boolean; claims: LicenseFileClaims }
  | { ok: false; reason: LicenseFileError; claims?: LicenseFileClaims }

/**
 * A verified licence file held to this product, this build and the app's
 * denylist, in this order: not valid (`unknown-key`, `bad-signature` and
 * `not-a-license-file` as they are; `bad-claims` and `malformed` as
 * `malformed`); another product (`wrong-product`); its id listed in `revoked`
 * (`revoked-file`); for an offline file, the build's major below `minMajor`
 * (absent: 1, `outdated`) or above `major` (`upgrade`). A key file covers what
 * its key does, which only the server can say, so no version is judged here.
 * A check that fails once the signature held keeps the claims, so its status
 * can still say whose file it is.
 */
export function checkLicenseFile(v: LicenseFileVerifyResult, product: string, major: number, revoked: readonly string[]): LicenseFileCheck {
  if (!v.valid) return { ok: false, reason: v.reason === 'bad-claims' ? 'malformed' : v.reason }
  const { claims } = v
  if (claims.product !== product) return { ok: false, reason: 'wrong-product', claims }
  if (revoked.includes(claims.fid)) return { ok: false, reason: 'revoked-file', claims }
  if (claims.kind === 'offline') {
    if (major < (claims.minMajor ?? 1)) return { ok: false, reason: 'outdated', claims }
    if (major > claims.major) return { ok: false, reason: 'upgrade', claims }
  }
  return { ok: true, kind: claims.kind, test: claims.test === true, claims }
}

/** Who a file is licensed to, as it signs it: a fresh frozen object, its absent members left out. */
export function licensedToOf(claims: Pick<LicenseFileClaims, 'name' | 'email'>): LicensedTo {
  return Object.freeze({
    ...(claims.name !== undefined ? { name: claims.name } : {}),
    ...(claims.email !== undefined ? { email: claims.email } : {}),
  })
}

/**
 * The status a STORED offline licence file gives (`source: 'file'` on every
 * one): licensed, with its key, who it is licensed to, `test` when it says so
 * and its entitlements when it grants any; `invalid` with `revoked-file`,
 * `upgrade` or `outdated`, its key and licensee, but no entitlements; `invalid`
 * / `unknown-key` when the build does not carry its key (nothing of it read);
 * and `invalid` / `tampered` for anything else, including a key file, which is
 * never stored (the state was edited).
 */
export function licenseFileStatus(check: LicenseFileCheck): LicenseStatus {
  if (check.ok && check.kind === 'offline' && check.claims.kind === 'offline') {
    const { claims } = check
    return { state: 'licensed', key: claims.sub, source: 'file', licensedTo: licensedToOf(claims), ...(check.test ? { test: true } : {}), ...entitled(claims.ent) }
  }
  if (!check.ok && check.claims && (check.reason === 'revoked-file' || check.reason === 'upgrade' || check.reason === 'outdated')) {
    return { state: 'invalid', reason: check.reason, key: check.claims.sub, source: 'file', licensedTo: licensedToOf(check.claims) }
  }
  if (!check.ok && check.reason === 'unknown-key') return { state: 'invalid', reason: 'unknown-key', source: 'file' }
  return { state: 'invalid', reason: 'tampered', source: 'file' }
}
