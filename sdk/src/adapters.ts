import { arch, hostname, platform } from 'node:os'
import { createHash } from 'node:crypto'
import type {
  Clock,
  DeviceIdentity,
  DeviceKind,
  Fingerprinter,
  HttpAdapter,
  RegistryStash,
} from './types.js'
import {
  ACTIVATE_MACHINE_ID_TIMEOUT_MS,
  readMachineId,
  systemMachineIdSource,
  type MachineIdReading,
  type MachineIdSource,
} from './machine-id.js'

export { KEEP_CORRUPT, STALE_TEMP_MS, createFileStorage, defaultStoragePath, legacyStoragePath } from './storage.js'
export type { StorageFs } from './storage.js'

/** Default registry stash: no-op. Electron/Windows apps inject a real one. */
export function noopRegistry(): RegistryStash {
  return {
    async readTrialStart() {
      return null
    },
    async writeTrialStart() {
      /* no-op */
    },
  }
}

export function systemClock(): Clock {
  return { now: () => Date.now() }
}

/** A machine's fingerprint from what identifies it, hashed so the raw identifier never leaves it. */
export function hashFingerprint(raw: string): string {
  return createHash('sha256').update(`keygrant|${raw}`).digest('hex')
}

/**
 * The host-name fingerprint: the host name, platform and architecture, hashed.
 * The fingerprint when the machine has no id to read, and offered as an
 * alternate beside the machine id's, so a device activated under it is still
 * itself.
 */
export function hostnameFingerprint(): string {
  return hostNamesFingerprint(hostNames())
}

/** What a host-name fingerprint hashes, as Node names them (`hostFingerprint`). */
export interface HostNames {
  host: string
  platform: string
  arch: string
}

/** This machine's host names, or null when they cannot be read. */
function hostNames(): HostNames | null {
  try {
    return { host: hostname(), platform: platform(), arch: arch() }
  } catch {
    return null
  }
}

/** The host-name fingerprint of these names; when they could not be read (null), UNKNOWN_HOST's. */
function hostNamesFingerprint(names: HostNames | null): string {
  return names === null ? hashFingerprint(UNKNOWN_HOST) : hostFingerprint(names.host, names.platform, names.arch)
}

/**
 * What `hostnameFingerprint` hashes, given the host name and Node's names for the
 * platform and architecture (`win32`/`darwin`/`linux`, `x64`/`arm64`/`ia32`/`arm`):
 * every SDK composes it the same way, so a machine is one device whichever reads it.
 */
export function hostFingerprint(host: string, platformName: string, archName: string): string {
  return hashFingerprint(`${host}|${platformName}|${archName}`)
}

/** What is hashed when not even the host name can be read. */
export const UNKNOWN_HOST = 'unknown-host'

/** The fingerprint of a machine id as `readMachineId` gives it. */
export function machineFingerprint(id: string): string {
  return hashFingerprint(`machine-id|${id}`)
}

/** The default fingerprinter's settled fingerprint for this process, once it has one. */
let processFingerprint: Settled | undefined

/** A settled fingerprint, and what it hashes. */
type Settled = { fingerprint: string; kind: DeviceKind }

/**
 * The default fingerprinter: the operating system's machine id (machine-id.ts),
 * which survives renaming the computer, hashed so the raw id never leaves the
 * machine; the host name's (`hostnameFingerprint`) when the machine has no id
 * to read, and `identify` says which (`kind`). A read that did not finish
 * gives NO fingerprint (`identify` answers `fingerprint: null`) and is not
 * kept, so the next call reads again: a slow read must never stand in for the
 * id, since a device's fingerprint must not change with how fast a command
 * ran. A settled fingerprint is kept for the process (for the fingerprinter,
 * when given its own `source`, as tests do).
 *
 * `get()` waits as long as an activation does and REJECTS when the id still
 * could not be read; the SDK itself uses `identify`. A wrapper around this
 * fingerprinter should implement or delegate `identify`, to keep the kind and
 * the host-name alternate.
 */
export function nodeFingerprinter(source?: MachineIdSource): Fingerprinter {
  let own: Settled | undefined
  const settled = () => (source ? own : processFingerprint)
  const keep = (found: Settled) => {
    if (source) own = found
    else processFingerprint = found
  }
  // As `identityOf`, with the settled fingerprint kept: the host name's
  // alternate is this call's, the fingerprint the one first settled on.
  const identify = async ({ timeoutMs }: { timeoutMs: number }): Promise<DeviceIdentity> => {
    const legacy = hostnameFingerprint()
    const known = settled() ?? (await readFingerprint(source ?? systemMachineIdSource(), timeoutMs))
    if (known !== null) keep(known)
    return withHostAlternate(known, legacy)
  }
  return {
    identify,
    async get() {
      const { fingerprint } = await identify({ timeoutMs: ACTIVATE_MACHINE_ID_TIMEOUT_MS })
      if (fingerprint === null) throw new Error('this machine’s id could not be read in time')
      return fingerprint
    },
  }
}

/** This machine's fingerprint and what it hashes, or null when its id could not be read this time. */
async function readFingerprint(source: MachineIdSource, timeoutMs: number): Promise<Settled | null> {
  return settledOn(await readMachineId(source, timeoutMs), hostnameFingerprint)
}

/**
 * Who this device is, as the default fingerprinter answers (`identify`), from
 * a reading of its machine id (machine-id.ts `readMachineId`) and its host
 * names (null when they cannot be read):
 *  - `id`: the machine id's fingerprint (`machineFingerprint`), kind `machine`,
 *    with the host name's (`hostFingerprint`) as an alternate, none when the
 *    two are the same;
 *  - `unavailable` (no id to read): the host name's, kind `hostname`, no
 *    alternate;
 *  - `transient` (the read did not finish): no fingerprint this time, and the
 *    host name's as an alternate.
 * The host name's is UNKNOWN_HOST's when the names cannot be read.
 */
export function identityOf(reading: MachineIdReading, host: HostNames | null): DeviceIdentity {
  const legacy = hostNamesFingerprint(host)
  return withHostAlternate(
    settledOn(reading, () => legacy),
    legacy,
  )
}

/**
 * What a reading of the machine id settles on: its fingerprint; the host
 * name's (`hostFp`, read only then) when there is no id to read; null when the
 * read did not finish, which settles nothing.
 */
function settledOn(reading: MachineIdReading, hostFp: () => string): Settled | null {
  if (reading.kind === 'id') return { fingerprint: machineFingerprint(reading.id), kind: 'machine' }
  return reading.kind === 'unavailable' ? { fingerprint: hostFp(), kind: 'hostname' } : null
}

/** Who a settled fingerprint is (null: none this time), with the host name's (`legacy`) as an alternate when it is another. */
function withHostAlternate(known: Settled | null, legacy: string): DeviceIdentity {
  if (known === null) return { fingerprint: null, alternates: [legacy] }
  const alternates = known.fingerprint === legacy ? [] : [legacy]
  return { fingerprint: known.fingerprint, kind: known.kind, alternates }
}

/** How long a request may take before it is abandoned, unless the call or the adapter says otherwise. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000

/**
 * HTTP over `fetch`, every call bounded: `timeoutMs` for this adapter
 * (DEFAULT_HTTP_TIMEOUT_MS when not given), or the call's own. Without a bound,
 * a network that accepts a connection and never answers (a captive portal, a
 * dead proxy) would hold a check-in, and whatever waits on it, for minutes.
 * Abandoned, the call throws, which the SDK treats as no network.
 */
export function fetchHttp(options: { timeoutMs?: number } = {}): HttpAdapter {
  const fallback = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  return {
    async post(url, body, opts = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? fallback)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        let json: unknown
        try {
          json = await res.json()
        } catch {
          json = undefined
        }
        return { status: res.status, json }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
