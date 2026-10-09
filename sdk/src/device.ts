import { fingerprintClaim } from '@keygrant/shared'
import type { DeviceIdentity, DeviceKind, Fingerprinter } from './types.js'
import { withTimeout } from './wire.js'

/**
 * Who this device is, for holding a lease to it (offline.ts `checkLease`) and
 * telling the server (a validate's `fingerprints`): as far as can be told this
 * call, and never guessed. A fingerprint that cannot be read in time is
 * "cannot tell" (`canTell` false), not a stand-in, and is read again next
 * call; only a settled answer is kept.
 */
export interface Device {
  /** This run's own fingerprint, or null when it cannot be told this time. */
  own: string | null
  /**
   * What `own` hashes: a machine id, or the host name; undefined when the
   * fingerprinter does not say (a custom `get()`), or with no `own`. A seat
   * keyed by a fingerprint of unknown kind is never held to its device.
   */
  kind?: DeviceKind
  canTell: boolean
  /** Every fingerprint this device answers to: its own first, then its alternates. */
  fingerprints: string[]
  /** Their `fp` claims (`fingerprintClaim`). */
  claims: string[]
  /** The claim of `own` alone, when there is one: what a `device` refusal is held to. */
  ownClaim?: string
  /**
   * The host-name fingerprint to activate under when the machine id cannot be
   * read even in an activation's time (license.ts), or null when there is none
   * (a custom fingerprinter that offers no alternates).
   */
  hostname: string | null
}

/**
 * Who this device is (`Device`), from what its fingerprinter said this time
 * (`identity`, `Fingerprinter.identify`), on an install keyed as `installKind`
 * (`StoredState.deviceKind`), held to its device or not (`deviceHold`,
 * `LicenseConfig.deviceHold`). `claimOf` is `fingerprintClaim`, which a reader
 * may remember.
 *
 * Install memory: once a machine id has keyed this install, a host-name answer
 * is not this device either. The id being unreadable now (an endpoint-security
 * tool blocking `reg.exe`, a command that failed once) says nothing about
 * whether the machine changed, so it is "cannot tell", never the host name.
 * A fingerprint of no kind (a custom `get()`) is not judged by it.
 *
 * Install memory applies only to a held device: not held, a host name is as
 * good an answer as any, and an install once keyed by a machine id must not
 * leave an unreadable id with no fingerprint to activate under. Not held
 * (`deviceHold` false), a device has no kind, so no seat is keyed to it, and
 * is judged as a run that cannot tell, so no lease is refused for its device
 * and the server is told no fingerprints. Its own still activates.
 */
export async function deviceFrom(
  identity: DeviceIdentity,
  installKind: DeviceKind | undefined,
  deviceHold: boolean,
  claimOf: (fingerprint: string) => Promise<string> = fingerprintClaim,
): Promise<Device> {
  const keyedAs = deviceHold ? installKind : undefined
  // A kind with no fingerprint says nothing.
  const read = identity.fingerprint === null ? undefined : identity.kind
  const own = read === 'hostname' && keyedAs === 'machine' ? null : identity.fingerprint
  const fingerprints = [...(own !== null ? [own] : []), ...identity.alternates.filter((f) => f !== own)]
  const hostname = read === 'hostname' ? identity.fingerprint : (identity.alternates[0] ?? null)
  const claims = await Promise.all(fingerprints.map((f) => claimOf(f)))
  const device = { own, canTell: own !== null, fingerprints, claims, hostname }
  if (!deviceHold) return { ...device, canTell: false }
  const mine = own !== null ? { ...device, ownClaim: claims[0] } : device
  return own !== null && read !== undefined ? { ...mine, kind: read } : mine
}

/** Reads, and once settled keeps, who this device is. */
export class DeviceIdentityReader {
  private known?: DeviceIdentity
  private readonly claims = new Map<string, string>()

  constructor(private readonly fingerprinter: Fingerprinter) {}

  /**
   * Who this device is (`deviceFrom`), reading for at most about `timeoutMs`,
   * on an install keyed as `installKind`, held to its device unless
   * `deviceHold` is false. A fingerprinter that rejects, or does not answer in
   * time, gives "cannot tell", not kept: a failed read must neither stand in
   * for the device nor stick.
   */
  async read(timeoutMs: number, installKind?: DeviceKind, deviceHold = true): Promise<Device> {
    const identity = this.known ?? (await this.identity(timeoutMs))
    if (identity.fingerprint !== null) this.known = identity
    return deviceFrom(identity, installKind, deviceHold, (fingerprint) => this.claimOf(fingerprint))
  }

  /** A fingerprint's claim (`fingerprintClaim`), remembered. */
  private async claimOf(fingerprint: string): Promise<string> {
    const known = this.claims.get(fingerprint)
    if (known !== undefined) return known
    const claim = await fingerprintClaim(fingerprint)
    this.claims.set(fingerprint, claim)
    return claim
  }

  /** The fingerprinter's answer, bounded; a custom `get()` says nothing of what it hashes. */
  private async identity(timeoutMs: number): Promise<DeviceIdentity> {
    try {
      if (this.fingerprinter.identify) {
        return await withTimeout(this.fingerprinter.identify({ timeoutMs }), timeoutMs + 1_000)
      }
      return { fingerprint: await withTimeout(this.fingerprinter.get(), timeoutMs), alternates: [] }
    } catch {
      return { fingerprint: null, alternates: [] }
    }
  }
}

/**
 * The fingerprint an activation is made under (a typed key's, license.ts, or
 * a bought key's claim, purchases.ts), and what it hashes; or null: an
 * activation answers `network` for the app to retry, and a claim is not asked.
 *
 * The device's own, given the time an activation deserves. When even that
 * cannot be told: on an install already keyed by a machine id, nothing (a
 * seat under the host name would read as another device to every normal run
 * after it); otherwise the host name, so a machine whose id never reads in
 * time can still activate. Its first check-in that reads the id moves the
 * seat to it (the server re-keys the seat). A fingerprinter with no host-name
 * alternate (a custom `get()`) activates nothing.
 */
export function activationIdentity(
  device: Device,
  installKind?: DeviceKind,
): { fingerprint: string; kind?: DeviceKind } | null {
  if (device.own !== null) return { fingerprint: device.own, ...(device.kind ? { kind: device.kind } : {}) }
  if (installKind === 'machine' || device.hostname === null) return null
  return { fingerprint: device.hostname, kind: 'hostname' }
}
