/**
 * The machine id (machine-id.ts): the filesystem /etc/machine-id is on (`mountinfo`,
 * `machineIdFilesystem`), and what reading it gives on each platform (`machineIds`,
 * `readMachineId`, from a scripted source). A group only ever grows at its end.
 */
import { BOOT_SLACK_MS } from '../../src/machine-id.js'
import type { GroupInputs } from '../inputs.js'
import type { ScriptedSource } from '../scripted.js'
import { DAY, DAY_MS, NOW, NOW_S } from './common.js'

type MachineIdCase = GroupInputs['machineIds']

const ROOT_EXT4 = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw'
const BTIME_S = NOW_S - DAY
const PROC_STAT = `cpu  1 2 3\nbtime ${BTIME_S}\nprocesses 99\n`
const ID = '4d2c1e0a9b8f7e6d5c4b3a2918070605'
const DBUS_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REG = 'C:\\Windows\\System32\\reg.exe'
const OTHER_REG = 'D:\\Windows\\System32\\reg.exe'
const IOREG = '/usr/sbin/ioreg'

const linux = (files: ScriptedSource['files']): ScriptedSource => ({ platform: 'linux', files })
/** What a Linux read finds besides the id: the root on ext4, and the boot time. */
const mounts = { '/proc/self/mountinfo': { content: ROOT_EXT4 }, '/proc/stat': { content: PROC_STAT } }
/** An id written long before this boot. */
const oldId = (content: string) => ({ content, mtimeMs: NOW - 400 * DAY_MS })
const regOutput = (guid: string) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n\r\n`
const ioregOutput = (uuid: string) =>
  `+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000201>\n    {\n      "IOPlatformSerialNumber" = "C02XXXX"\n      "IOPlatformUUID" = "${uuid}"\n    }\n`

export function mountinfo(): GroupInputs['mountinfo'][] {
  return [
    { name: 'the root alone, on ext4', mountinfo: `${ROOT_EXT4}\n24 22 0:22 / /proc rw - proc proc rw` },
    { name: '/etc on a tmpfs', mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /etc rw - tmpfs tmpfs rw` },
    { name: 'a tmpfs file bound over the id', mountinfo: `${ROOT_EXT4}\n31 22 0:31 /machine-id /etc/machine-id ro - tmpfs tmpfs rw` },
    { name: 'a stable id bound in from ext4', mountinfo: `${ROOT_EXT4}\n32 22 8:2 /ids/machine-id /etc/machine-id ro - ext4 /dev/sdb1 rw` },
    { name: 'a ramfs root', mountinfo: '22 1 0:2 / / rw - ramfs rootfs rw' },
    {
      name: 'an overlay mounted over a tmpfs /etc: the one on top',
      mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /etc rw - tmpfs tmpfs rw\n40 30 0:40 / /etc rw - overlay overlay rw`,
    },
    {
      name: 'two mounts at one point that do not say which is on top: the last listed',
      mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /etc rw - xfs /dev/sdc rw\n31 22 0:31 / /etc rw - tmpfs tmpfs rw`,
    },
    { name: 'an octal-escaped mount point', mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /\\145tc rw - tmpfs tmpfs rw` },
    { name: 'a mount point that only shares a prefix', mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /etc2 rw - tmpfs tmpfs rw` },
    { name: 'optional fields before the separator', mountinfo: '22 1 8:1 / / rw shared:1 master:2 - btrfs /dev/nvme0n1p2 rw' },
    { name: 'nothing readable', mountinfo: 'garbage\n\n1 2 3' },
    { name: 'empty', mountinfo: '' },
    // A prefix of the path that does not end on a path boundary holds nothing of it.
    { name: 'a tmpfs at /etc/machine, a prefix of the file name', mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /etc/machine rw - tmpfs tmpfs rw` },
    { name: 'a tmpfs at /et, a prefix of the folder name', mountinfo: `${ROOT_EXT4}\n30 22 0:30 / /et rw - tmpfs tmpfs rw` },
  ]
}

export function machineIds(): MachineIdCase[] {
  return [...linuxIds(), ...linuxBoots(), ...windowsIds(), ...macIds(), ...linuxFailures(), ...linuxMore(), ...windowsSystemRoot()]
}

function linuxIds(): MachineIdCase[] {
  return [
    { name: 'Linux: the systemd id', source: linux({ ...mounts, '/etc/machine-id': oldId(`${ID}\n`) }) },
    { name: 'Linux: the id with spaces around it', source: linux({ ...mounts, '/etc/machine-id': oldId(`  ${ID} \n`) }) },
    { name: 'Linux: no systemd id, the D-Bus one', source: linux({ ...mounts, '/var/lib/dbus/machine-id': oldId(DBUS_ID) }) },
    {
      name: 'Linux: an empty systemd file falls through to D-Bus',
      source: linux({ ...mounts, '/etc/machine-id': oldId(''), '/var/lib/dbus/machine-id': oldId(DBUS_ID) }),
    },
    {
      name: 'Linux: a systemd file we may not read falls through',
      source: linux({ ...mounts, '/etc/machine-id': { error: { code: 'EACCES' } }, '/var/lib/dbus/machine-id': oldId(DBUS_ID) }),
    },
    { name: 'Linux: neither file', source: linux({ ...mounts }) },
    { name: 'Linux: an error nobody expected is this time only', source: linux({ ...mounts, '/etc/machine-id': { error: { code: 'EIO' } } }) },
    {
      name: 'Linux: /etc on a tmpfs is no id',
      source: linux({
        '/proc/self/mountinfo': { content: `${ROOT_EXT4}\n30 22 0:30 / /etc rw - tmpfs tmpfs rw` },
        '/proc/stat': { content: PROC_STAT },
        '/etc/machine-id': oldId(ID),
      }),
    },
    {
      name: 'Linux: a stable id bound in from ext4 is an id',
      source: linux({
        '/proc/self/mountinfo': { content: `${ROOT_EXT4}\n32 22 8:2 /ids/machine-id /etc/machine-id ro - ext4 /dev/sdb1 rw` },
        '/proc/stat': { content: PROC_STAT },
        '/etc/machine-id': oldId(ID),
      }),
    },
    {
      name: 'Linux: mountinfo unreadable leaves the id as read',
      source: linux({ '/proc/stat': { content: PROC_STAT }, '/etc/machine-id': oldId(ID) }),
    },
  ]
}

/** An id written at this boot (mtime at or after `btime`, less BOOT_SLACK_MS) is no id. */
function linuxBoots(): MachineIdCase[] {
  return [
    {
      name: 'Linux: written at the boot time, less the slack, is no id',
      source: linux({ ...mounts, '/etc/machine-id': { content: ID, mtimeMs: BTIME_S * 1000 - BOOT_SLACK_MS } }),
    },
    {
      name: 'Linux: written a millisecond before that is an id',
      source: linux({ ...mounts, '/etc/machine-id': { content: ID, mtimeMs: BTIME_S * 1000 - BOOT_SLACK_MS - 1 } }),
    },
    { name: 'Linux: written after boot is no id', source: linux({ ...mounts, '/etc/machine-id': { content: ID, mtimeMs: NOW - 1000 } }) },
    {
      name: 'Linux: no boot time in /proc/stat leaves the id as read',
      source: linux({
        '/proc/self/mountinfo': { content: ROOT_EXT4 },
        '/proc/stat': { content: 'cpu 1 2 3\n' },
        '/etc/machine-id': { content: ID, mtimeMs: NOW - 1000 },
      }),
    },
    {
      name: 'Linux: the D-Bus id written at this boot is no id',
      source: linux({ ...mounts, '/var/lib/dbus/machine-id': { content: DBUS_ID, mtimeMs: NOW - 1000 } }),
    },
  ]
}

function windowsIds(): MachineIdCase[] {
  return [
    { name: 'Windows: the MachineGuid', source: { platform: 'win32', commands: { [REG]: { output: regOutput('8a1f0c2e-6b1d-4f7e-9c3a-2d5e7f9a1b3c') } } } },
    {
      name: 'Windows: reg.exe not where it should be, but under SystemRoot',
      source: {
        platform: 'win32',
        systemRoot: 'D:\\Windows',
        commands: { [OTHER_REG]: { output: regOutput('8A1F0C2E-6B1D-4F7E-9C3A-2D5E7F9A1B3C') } },
      },
    },
    { name: 'Windows: no MachineGuid in the output', source: { platform: 'win32', commands: { [REG]: { output: '\r\nERROR\r\n' } } } },
    { name: 'Windows: reg.exe said no', source: { platform: 'win32', commands: { [REG]: { error: { code: 1 } } } } },
    { name: 'Windows: reg.exe killed at its time box', source: { platform: 'win32', commands: { [REG]: { error: { killed: true, signal: 'SIGTERM' } } } } },
    { name: 'Windows: no reg.exe anywhere', source: { platform: 'win32' } },
  ]
}

function macIds(): MachineIdCase[] {
  return [
    { name: 'macOS: the IOPlatformUUID', source: { platform: 'darwin', commands: { [IOREG]: { output: ioregOutput('5E8A9B1C-2D3E-4F50-8172-93A4B5C6D7E8') } } } },
    { name: 'macOS: no IOPlatformUUID in the output', source: { platform: 'darwin', commands: { [IOREG]: { output: '+-o Root\n' } } } },
    { name: 'macOS: ioreg killed by a signal', source: { platform: 'darwin', commands: { [IOREG]: { error: { signal: 'SIGKILL' } } } } },
    { name: 'macOS: an error nobody expected is this time only', source: { platform: 'darwin', commands: { [IOREG]: { error: { code: 'EAGAIN' } } } } },
    { name: 'macOS: no ioreg', source: { platform: 'darwin' } },
  ]
}

/**
 * Errors reading /etc/machine-id that mean there is nothing to read (EPERM,
 * ENOTDIR, EISDIR) fall through to the D-Bus id, and with none are no id; an
 * error nobody expected does not fall through.
 */
function linuxFailures(): MachineIdCase[] {
  const forGood = ['EPERM', 'ENOTDIR', 'EISDIR'].flatMap((code): MachineIdCase[] => [
    {
      name: `Linux: ${code} on the systemd file falls through to D-Bus`,
      source: linux({ ...mounts, '/etc/machine-id': { error: { code } }, '/var/lib/dbus/machine-id': oldId(DBUS_ID) }),
    },
    { name: `Linux: ${code} on the systemd file and no D-Bus id`, source: linux({ ...mounts, '/etc/machine-id': { error: { code } } }) },
  ])
  return [
    ...forGood,
    {
      name: 'Linux: an error nobody expected does not fall through to D-Bus',
      source: linux({ ...mounts, '/etc/machine-id': { error: { code: 'EIO' } }, '/var/lib/dbus/machine-id': oldId(DBUS_ID) }),
    },
  ]
}

/** A root in memory, and an id whose age cannot be told. */
function linuxMore(): MachineIdCase[] {
  return [
    {
      name: 'Linux: a ramfs root is no id',
      source: linux({ '/proc/self/mountinfo': { content: '22 1 0:2 / / rw - ramfs rootfs rw' }, '/proc/stat': { content: PROC_STAT }, '/etc/machine-id': oldId(ID) }),
    },
    { name: 'Linux: an id with no time it was written is an id', source: linux({ ...mounts, '/etc/machine-id': { content: ID } }) },
    {
      name: 'Linux: /proc/stat missing leaves an old id as read',
      source: linux({ '/proc/self/mountinfo': { content: ROOT_EXT4 }, '/etc/machine-id': oldId(ID) }),
    },
    {
      name: 'Linux: /proc/stat missing leaves an id written after boot as read',
      source: linux({ '/proc/self/mountinfo': { content: ROOT_EXT4 }, '/etc/machine-id': { content: ID, mtimeMs: NOW - 1000 } }),
    },
  ]
}

/** `%SystemRoot%` is never preferred to the standard reg.exe, and tried only when that is not there (ENOENT). */
function windowsSystemRoot(): MachineIdCase[] {
  const elsewhere = { [OTHER_REG]: { output: regOutput('11111111-2222-3333-4444-555555555555') } }
  return [
    {
      name: "Windows: both reg.exe answer: the standard one's",
      source: { platform: 'win32', systemRoot: 'D:\\Windows', commands: { [REG]: { output: regOutput('8a1f0c2e-6b1d-4f7e-9c3a-2d5e7f9a1b3c') }, ...elsewhere } },
    },
    {
      name: 'Windows: the standard reg.exe said no: not asked under SystemRoot',
      source: { platform: 'win32', systemRoot: 'D:\\Windows', commands: { [REG]: { error: { code: 1 } }, ...elsewhere } },
    },
    {
      name: 'Windows: the standard reg.exe killed: not asked under SystemRoot',
      source: { platform: 'win32', systemRoot: 'D:\\Windows', commands: { [REG]: { error: { killed: true, signal: 'SIGTERM' } }, ...elsewhere } },
    },
  ]
}
