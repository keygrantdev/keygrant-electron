import type { Entitlements } from '@keygrant/shared'

/**
 * Whether entitlements grant `code`: a flag that is on, a number that is not
 * zero, or a text that is not empty. Absent, off, zero or empty is not granted.
 * The name is matched exactly, case included, and only as the entitlements'
 * own member, so a name such as `constructor` is granted only when signed.
 */
export function grants(entitlements: Entitlements | undefined, code: string): boolean {
  if (entitlements === undefined || !Object.hasOwn(entitlements, code)) return false
  const value = entitlements[code]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return typeof value === 'string' && value.length > 0
}

/** What `License.require` throws when the licence does not grant an entitlement: names it as `entitlement`. */
export class MissingEntitlementError extends Error {
  /** The entitlement's code, as the app asked for it. */
  readonly entitlement: string

  constructor(entitlement: string) {
    super(`the licence does not grant "${entitlement}"`)
    this.name = 'MissingEntitlementError'
    this.entitlement = entitlement
  }
}
