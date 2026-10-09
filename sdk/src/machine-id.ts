import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { withTimeout } from './wire.js'

/**
 * The operating system's own id for this machine, which the default
 * fingerprinter (adapters.ts `nodeFingerprinter`) hashes. It survives renaming
 * the computer, which the host name does not: with every lease held to its
 * device (`fp`), a fingerprint that changed on a rename would lock a customer
 * out and cost a seat.
 *
 *  - Windows: `MachineGuid` under `HKLM\SOFTWARE\Microsoft\Cryptography`, read
 *    from the 64-bit registry view (`/reg:64`), which a 32-bit process under
 *    WOW64 otherwise never sees.
 *  - macOS: `IOPlatformUUID` of the platform expert device.
 *  - Linux (and anything else): `/etc/machine-id`, else `/var/lib/dbus/machine-id`.
 *
 * Read with what every install already has (`reg`, `ioreg`, the file), by
 * absolute path, no new dependency.
 *
 * What a read gives is one of three, and the difference is what keeps a
 * device's identity from ever changing because a read was slow:
 *  - `id`: the machine's id.
 *  - `unavailable`: there is none to read, and there will not be on the next
 *    try either (the command or file is missing, access is denied, the output
 *    holds no id). The fingerprint falls back to the host name, consistently.
 *  - `transient`: the read did not finish (a timeout, a process killed, an
 *    error nobody expected). There is NO fingerprint this time, and the next
 *    call reads again.
 */

/** How long `status()` may spend reading the machine id. */
export const MACHINE_ID_TIMEOUT_MS = 2_000

/** How long `activate()` may spend reading it: a person is waiting, and a seat is at stake. */
export const ACTIVATE_MACHINE_ID_TIMEOUT_MS = 10_000

/** What reading the machine id gave. */
export type MachineIdReading = { kind: 'id'; id: string } | { kind: 'unavailable' } | { kind: 'transient' }

/** Where the machine id is read from: the real system, or a stand-in in tests. */
export interface MachineIdSource {
  platform: string
  /** Windows' own folder (`%SystemRoot%`), where `reg.exe` is. */
  systemRoot?: string
  /**
   * A command's standard output. Rejects, as `execFile` does, with `code` the
   * exit code (a number) when the command ran and failed, an errno string
   * (`ENOENT`) when it could not be run, or `killed` when it outlived `timeoutMs`.
   */
  run(command: string, args: string[], timeoutMs: number): Promise<string>
  /** A file's text; rejects with an errno `code` (`ENOENT`, `EACCES`) when it cannot be read. */
  readFile(path: string): Promise<string>
  /** When a file's content was last written (ms); absent, the id's age is not judged. */
  stat?(path: string): Promise<{ mtimeMs: number }>
}

/** The real system: `execFile`, killed at its time box, and the file system. */
export function systemMachineIdSource(): MachineIdSource {
  return {
    platform: platform(),
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    run: (command, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        )
      }),
    readFile: (path) => readFile(path, 'utf8'),
    stat: async (path) => ({ mtimeMs: (await stat(path)).mtimeMs }),
  }
}

/** Where Windows keeps it, in the 64-bit view whatever this process is. */
const WINDOWS_MACHINE_GUID = ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']

/** Where Windows keeps `reg.exe`, as installed. */
const STANDARD_REG = 'C:\\Windows\\System32\\reg.exe'

/** Where macOS keeps `ioreg`. */
const IOREG = '/usr/sbin/ioreg'

/** Where Linux keeps it: systemd's file, else the D-Bus one older systems have. */
const LINUX_MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']

/** Errors that mean there is nothing to read, now or on the next try. */
const UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'])

/**
 * This machine's id, or why there is none (above). Never throws, and never
 * takes much longer than `timeoutMs`: the command is killed at it, and
 * abandoned shortly after even if the kill does not end it.
 */
export async function readMachineId(
  source: MachineIdSource,
  timeoutMs = MACHINE_ID_TIMEOUT_MS,
): Promise<MachineIdReading> {
  try {
    if (source.platform === 'win32') {
      const out = await windowsRegistry(source, timeoutMs)
      return idIn(/MachineGuid\s+REG_SZ\s+(\S+)/.exec(out))
    }
    if (source.platform === 'darwin') {
      const out = await bounded(source, IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], timeoutMs)
      return idIn(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out))
    }
    // An id on a filesystem in memory is new every boot: no id to hold a device to.
    if (await transientMachineId(source, timeoutMs)) return { kind: 'unavailable' }
    for (const path of LINUX_MACHINE_ID_FILES) {
      const reading = await fromFile(source, path, timeoutMs)
      if (reading.kind === 'unavailable') continue
      // Written at this boot: a volatile root, whatever its filesystem.
      if (reading.kind === 'id' && (await writtenThisBoot(source, path, timeoutMs))) return { kind: 'unavailable' }
      return reading
    }
    return { kind: 'unavailable' }
  } catch (error) {
    return { kind: failureKind(error) }
  }
}

/** Filesystems held in memory: an id on one of them is written afresh every boot. */
const IN_MEMORY = new Set(['tmpfs', 'ramfs'])

/**
 * Whether /etc/machine-id lives on a filesystem in memory, and so changes every
 * boot: systemd's transient id (a file on a /run tmpfs bound over it, on a
 * read-only root) and an impermanent root or /etc that is itself a tmpfs,
 * where systemd writes a fresh id at each boot. Judged by the filesystem that
 * holds the file (`machineIdFilesystem`), not by whether something is mounted
 * on it: a stable id bound into place (Flatpak's `--ro-bind`, a container's
 * volume) lives on a persistent filesystem and stays an id. False when
 * mountinfo cannot be read, which leaves the id read as it always was.
 */
async function transientMachineId(source: MachineIdSource, timeoutMs: number): Promise<boolean> {
  try {
    const info = await withTimeout(source.readFile('/proc/self/mountinfo'), timeoutMs)
    const fstype = machineIdFilesystem(info)
    return fstype !== null && IN_MEMORY.has(fstype)
  } catch {
    return false
  }
}

/** The path whose filesystem says whether the id is transient. */
const MACHINE_ID = '/etc/machine-id'

/**
 * The type of the filesystem /etc/machine-id is on, from `/proc/self/mountinfo`
 * (one mount per line: the mount point is the fifth field, octal-escaped; the
 * type is the first field after the ` - ` separator). The mount holding it is
 * the one whose mount point is the longest prefix of the path on a path
 * boundary; of several at that point, the last, which is mounted over the
 * rest. Null when no line can be read so.
 */
export function machineIdFilesystem(mountinfo: string): string | null {
  const mounts: Mount[] = []
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ')
    const [id, parent, , , raw] = fields
    const separator = fields.indexOf('-', 6)
    const fstype = separator > 0 ? fields[separator + 1] : undefined
    if (id === undefined || parent === undefined || raw === undefined || fstype === undefined) continue
    const point = raw.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    if (point === MACHINE_ID || point === '/' || MACHINE_ID.startsWith(`${point}/`)) mounts.push({ id, parent, point, fstype })
  }
  const deepest = Math.max(...mounts.map((m) => m.point.length))
  return topMount(mounts.filter((m) => m.point.length === deepest))?.fstype ?? null
}

/** One line of mountinfo that holds /etc/machine-id: its id, its parent's, its mount point and type. */
interface Mount {
  id: string
  parent: string
  point: string
  fstype: string
}

/**
 * Of mounts at one point, the one on top: the one no other there names as its
 * parent (field 2), which is what a mount over another is. When that does not
 * settle it (none, or more than one), the last listed.
 */
function topMount(atPoint: Mount[]): Mount | undefined {
  const tops = atPoint.filter((m) => !atPoint.some((other) => other !== m && other.parent === m.id))
  return tops.length === 1 ? tops[0] : atPoint[atPoint.length - 1]
}

/**
 * How far before the boot time an id may have been written and still count as
 * written at this boot: `btime` is whole seconds, and the file is written in
 * the first moments of boot.
 */
export const BOOT_SLACK_MS = 5_000

/**
 * Whether the machine-id file was written at this boot: its content (mtime) no
 * older than the system's boot time (`btime` in `/proc/stat`, less
 * BOOT_SLACK_MS).
 * Then it was generated now, on a root that does not keep it across boots,
 * whatever that root's filesystem (an overlay with a tmpfs upper on a live USB,
 * a btrfs rolled back every boot, a zram /etc): no id to hold a device to. On
 * a normal system the id dates from the install, long before boot; on the
 * first boot after an install it is new for that boot only, and the seat moves
 * to it at a later boot. A wrong clock at boot that is put right afterwards
 * can only make the file look older, so stable. False when either cannot be
 * read, which leaves the id read as it always was. Never throws.
 *
 * mtime only, never ctime: ctime moves whenever the file's inode does (an
 * SELinux relabel at boot, a chmod, an ACL, a restore from backup), none of
 * which is a new id: it would only make a stable id count as none for a boot
 * (the host name, or "cannot tell"). The case mtime misses is a niche one, and
 * it goes against the customer: a device with no real-time clock (a Raspberry
 * Pi without one) that also regenerates its id every boot writes it before the
 * network sets the clock, with a time from before the boot time it reads
 * afterwards. That id reads as stable, its seat is held to it, and the next
 * boot is refused `device`. A product shipped on such devices sets
 * `deviceHold: false`.
 */
async function writtenThisBoot(source: MachineIdSource, path: string, timeoutMs: number): Promise<boolean> {
  try {
    if (!source.stat) return false
    const [written, procStat] = await Promise.all([
      withTimeout(source.stat(path), timeoutMs),
      withTimeout(source.readFile('/proc/stat'), timeoutMs),
    ])
    const btime = /^btime (\d+)$/m.exec(procStat)?.[1]
    if (btime === undefined) return false
    return written.mtimeMs >= Number(btime) * 1000 - BOOT_SLACK_MS
  } catch {
    return false
  }
}

/** A file's id, or why there is none. */
async function fromFile(source: MachineIdSource, path: string, timeoutMs: number): Promise<MachineIdReading> {
  try {
    const id = (await withTimeout(source.readFile(path), timeoutMs)).trim()
    return id ? { kind: 'id', id } : { kind: 'unavailable' }
  } catch (error) {
    return { kind: failureKind(error) }
  }
}

/**
 * `reg query` for the MachineGuid, by the standard path first. `%SystemRoot%`
 * is the process's environment, which anything that starts the app can set:
 * it is used only when Windows is not where it normally is (the standard
 * `reg.exe` is not there), never in preference to it.
 */
async function windowsRegistry(source: MachineIdSource, timeoutMs: number): Promise<string> {
  try {
    return await bounded(source, STANDARD_REG, WINDOWS_MACHINE_GUID, timeoutMs)
  } catch (error) {
    const elsewhere = source.systemRoot ? `${source.systemRoot}\\System32\\reg.exe` : undefined
    if (!elsewhere || elsewhere === STANDARD_REG || (error as { code?: unknown }).code !== 'ENOENT') throw error
    return bounded(source, elsewhere, WINDOWS_MACHINE_GUID, timeoutMs)
  }
}

function bounded(source: MachineIdSource, command: string, args: string[], timeoutMs: number): Promise<string> {
  return withTimeout(source.run(command, args, timeoutMs), timeoutMs + 500)
}

function idIn(match: RegExpExecArray | null): MachineIdReading {
  const id = match?.[1]?.trim()
  return id ? { kind: 'id', id } : { kind: 'unavailable' }
}

/**
 * Whether a failed read is for good (`unavailable`) or this time only
 * (`transient`). A command that ran and said no (an exit code), or one or a
 * file that is not there or not ours to read, is for good. A process killed at
 * its time box, our own time box, and anything unexpected are this time only:
 * guessing "for good" there is what flipped a device's fingerprint.
 */
function failureKind(error: unknown): 'unavailable' | 'transient' {
  if (typeof error !== 'object' || error === null) return 'transient'
  const e = error as { code?: unknown; killed?: unknown; signal?: unknown }
  if (e.killed === true || (e.signal !== undefined && e.signal !== null)) return 'transient'
  if (typeof e.code === 'number') return 'unavailable'
  return typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code) ? 'unavailable' : 'transient'
}
