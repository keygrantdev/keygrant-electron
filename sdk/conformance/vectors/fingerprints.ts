/**
 * Who a device is: the hashes (`fingerprintClaims`, `fingerprints`,
 * `machineFingerprints`, `hostFingerprints`), what the default fingerprinter
 * makes of a machine-id reading (`identities`, adapters.ts `identityOf`), and
 * the device the SDK reads from a fingerprinter's answer (`devices`, device.ts
 * `deviceFrom`).
 */
import { UNKNOWN_HOST, hostFingerprint, machineFingerprint, type HostNames } from '../../src/adapters.js'
import type { GroupInputs, IdentityJson } from '../inputs.js'

const GUID = '8a1f0c2e-6b1d-4f7e-9c3a-2d5e7f9a1b3c'

export function fingerprintClaims(): GroupInputs['fingerprintClaims'][] {
  return ['', 'fingerprint-machine-own', `machine-id|${GUID}`, 'ünïcødé ✓'].map((input) => ({ input }))
}

export function fingerprints(): GroupInputs['fingerprints'][] {
  return [`machine-id|${GUID}`, 'DESKTOP-1|win32|x64', UNKNOWN_HOST, '', 'Рэй|linux|arm64'].map((raw) => ({ raw }))
}

export function machineFingerprints(): GroupInputs['machineFingerprints'][] {
  return [
    { id: GUID },
    // Case is kept: a Windows MachineGuid and a Mac's IOPlatformUUID are read as written.
    { id: GUID.toUpperCase() },
    { id: '4d2c1e0a9b8f7e6d5c4b3a2918070605' },
  ]
}

export function hostFingerprints(): GroupInputs['hostFingerprints'][] {
  return [
    { host: 'DESKTOP-7Q2', platform: 'win32', arch: 'x64' },
    { host: 'Raes-MacBook-Pro.local', platform: 'darwin', arch: 'arm64' },
    { host: 'build-box', platform: 'linux', arch: 'ia32' },
    { host: 'pi', platform: 'linux', arch: 'arm' },
    { host: 'ПК-Рэй', platform: 'win32', arch: 'x64' },
  ]
}

/** The default fingerprinter's answer from a reading of the machine id and the host names (null: unreadable). */
export function identities(): GroupInputs['identities'][] {
  const windows: HostNames = { host: 'DESKTOP-7Q2', platform: 'win32', arch: 'x64' }
  // A machine id whose raw form is the host name's (`machine-id|linux|x64`): one fingerprint, so no alternate.
  const twin: HostNames = { host: 'machine-id', platform: 'linux', arch: 'x64' }
  return [
    { name: "an id: the machine id's fingerprint, the host name's an alternate", reading: { kind: 'id', id: GUID }, host: windows },
    { name: "no id to read: the host name's, with no alternate", reading: { kind: 'unavailable' }, host: windows },
    { name: "a read that did not finish: no fingerprint, the host name's an alternate", reading: { kind: 'transient' }, host: windows },
    { name: "an id, the host names unreadable: the unknown host's the alternate", reading: { kind: 'id', id: GUID }, host: null },
    { name: "no id, the host names unreadable: the unknown host's", reading: { kind: 'unavailable' }, host: null },
    { name: 'a read that did not finish, the host names unreadable', reading: { kind: 'transient' }, host: null },
    { name: "an id whose fingerprint is the host name's: no alternate", reading: { kind: 'id', id: 'linux|x64' }, host: twin },
    {
      name: "a Mac's id",
      reading: { kind: 'id', id: '5E8A9B1C-2D3E-4F50-8172-93A4B5C6D7E8' },
      host: { host: 'Raes-MacBook-Pro.local', platform: 'darwin', arch: 'arm64' },
    },
    { name: 'a Linux id', reading: { kind: 'id', id: '4d2c1e0a9b8f7e6d5c4b3a2918070605' }, host: { host: 'build-box', platform: 'linux', arch: 'x64' } },
  ]
}

/** The device the SDK reads from a fingerprinter's answer, on an install keyed so, held or not. */
export function devices(): GroupInputs['devices'][] {
  const machine = machineFingerprint(GUID)
  const host = hostFingerprint('DESKTOP-7Q2', 'win32', 'x64')
  const oldHost = hostFingerprint('DESKTOP-OLD', 'win32', 'x64')
  const idRead: IdentityJson = { fingerprint: machine, kind: 'machine', alternates: [host] }
  const hostRead: IdentityJson = { fingerprint: host, kind: 'hostname', alternates: [] }
  const unfinished: IdentityJson = { fingerprint: null, kind: null, alternates: [host] }
  // A custom fingerprinter's `get()`: it says nothing of what it hashes, and offers no alternates.
  const custom: IdentityJson = { fingerprint: 'licence-dongle-4471', kind: null, alternates: [] }
  const failed: IdentityJson = { fingerprint: null, kind: null, alternates: [] }
  return [
    { name: "a machine id read: its own, the host name's an alternate", identity: idRead, installKind: null, deviceHold: true },
    { name: 'a machine id read on an install keyed by it', identity: idRead, installKind: 'machine', deviceHold: true },
    { name: 'a machine id read on an install keyed by the host name', identity: idRead, installKind: 'hostname', deviceHold: true },
    { name: 'the host name on an install keyed by a machine id: cannot tell', identity: hostRead, installKind: 'machine', deviceHold: true },
    { name: 'the host name on an install keyed by nothing: the host name', identity: hostRead, installKind: null, deviceHold: true },
    { name: 'the host name on an install keyed by it', identity: hostRead, installKind: 'hostname', deviceHold: true },
    { name: "a read that did not finish: cannot tell, the host name's still an alternate", identity: unfinished, installKind: null, deviceHold: true },
    { name: 'a read that did not finish, on an install keyed by a machine id', identity: unfinished, installKind: 'machine', deviceHold: true },
    { name: 'a kind with no fingerprint is no kind', identity: { ...unfinished, kind: 'machine' }, installKind: null, deviceHold: true },
    { name: 'a custom get(): its own, of no kind, with no host name', identity: custom, installKind: null, deviceHold: true },
    { name: 'a custom get() on an install keyed by a machine id: still its own', identity: custom, installKind: 'machine', deviceHold: true },
    { name: 'a custom get() that failed: nothing at all', identity: failed, installKind: null, deviceHold: true },
    {
      name: 'an alternate that is the fingerprint itself is answered to once',
      identity: { ...idRead, alternates: [machine, host] },
      installKind: null,
      deviceHold: true,
    },
    {
      name: 'several alternates: all answered to, the first the host name',
      identity: { ...idRead, alternates: [host, oldHost] },
      installKind: null,
      deviceHold: true,
    },
    { name: 'not held: a machine id read is of no kind and cannot tell, its own kept', identity: idRead, installKind: 'machine', deviceHold: false },
    { name: 'not held: the host name on an install keyed by a machine id is its own', identity: hostRead, installKind: 'machine', deviceHold: false },
    { name: 'not held: a read that did not finish', identity: unfinished, installKind: 'machine', deviceHold: false },
    { name: 'not held: a custom get()', identity: custom, installKind: null, deviceHold: false },
  ]
}
