import { basename, dirname, posix, resolve, win32 } from 'node:path'
import { homedir, platform } from 'node:os'
import type { StorageAdapter, StoredState } from './types.js'
import {
  RENAME_BACKOFF_MS,
  busy,
  clearStale,
  codeOf,
  leftover,
  missing,
  nodeFs,
  pruneCorrupt,
  readText,
  retrying,
  writeTemp,
  type StorageFs,
} from './storage-fs.js'

export { KEEP_CORRUPT, STALE_TEMP_MS } from './storage-fs.js'
export type { StorageFile, StorageFs } from './storage-fs.js'

/**
 * The SDK's default state file: where it lives, and how it is read and
 * written so that neither a crash nor a busy disk ever costs a customer their
 * licence.
 */

/**
 * Where the default storage keeps a product's state: a folder of this user's
 * on THIS machine, never the working directory (Program Files on Windows, or /
 * for a Mac app started from the Finder, where every save failed), and never a
 * folder that roams between machines (Windows' Roaming AppData on a domain
 * with roaming profiles or redirected folders), where one state file shared by
 * several machines would be "another device" on each in turn:
 *  - Windows: `%LOCALAPPDATA%\KeyGrant`, else `~\AppData\Local\KeyGrant`
 *  - macOS: `~/Library/Application Support/KeyGrant`
 *  - Linux and others: `$XDG_CONFIG_HOME/keygrant`, else `~/.config/keygrant`
 * An empty or relative variable is taken as unset (as the XDG spec says of
 * `$XDG_CONFIG_HOME`), or the state would land in the working directory after
 * all. A home directory shared between machines (NFS) needs `deviceHold: false`
 * or a machine-local `storage` adapter. An app's own `storage` adapter is used
 * instead whenever it gives one.
 */
export function defaultStoragePath(
  product: string,
  system: { platform: string; homedir: string; env: Record<string, string | undefined> } = {
    platform: platform(),
    homedir: homedir(),
    env: process.env,
  },
): string {
  const file = `${product}.json`
  const absolute = (value: string | undefined, isAbsolute: (p: string) => boolean) =>
    value && isAbsolute(value) ? value : undefined
  if (system.platform === 'win32') {
    const local = absolute(system.env.LOCALAPPDATA, win32.isAbsolute) ?? win32.join(system.homedir, 'AppData', 'Local')
    return win32.join(local, 'KeyGrant', file)
  }
  if (system.platform === 'darwin') {
    return posix.join(system.homedir, 'Library', 'Application Support', 'KeyGrant', file)
  }
  const config = absolute(system.env.XDG_CONFIG_HOME, posix.isAbsolute) ?? posix.join(system.homedir, '.config')
  return posix.join(config, 'keygrant', file)
}

/** Where SDKs before the per-user default kept a product's state: relative to the working directory. */
export function legacyStoragePath(product: string): string {
  return resolve('.keygrant', `${product}.json`)
}

/** How many times a save is merged onto a state another process changed under it before it fails. */
export const UPDATE_ATTEMPTS = 5

/** The code of the error a save fails with when the state kept changing under it (UPDATE_ATTEMPTS). */
export const CONFLICT = 'ECONFLICT'

/**
 * JSON file storage (e.g. `%LOCALAPPDATA%\MyApp\license.json`).
 *
 * Read: only a MISSING file is "no state". Then its newest whole temp file is
 * read (a write that finished but was never renamed in, a crash in between),
 * else the state an older SDK kept (`migrateFrom`), copied over once. Any other
 * failure to read is tried again for about a second and then THROWS: a call
 * built on a read that failed would write what it read over the real state
 * (every save is read, patch, write), so it fails, to be retried. A file that
 * reads but does not parse is set aside (renamed to `<file>.<time>.corrupt`,
 * kept for anyone who wants to look; the newest KEEP_CORRUPT of them, so a
 * file that keeps going bad cannot fill the disk) and the state starts afresh,
 * an empty state written in its place: neither written over in silence nor
 * replaced by an older temp or the old SDK's state at a later read. When it
 * cannot be set aside, the read throws, as for a file that cannot be read. A
 * read-only read (`readOnly`, behind a call that has not finished) does
 * neither the copy nor the set-aside: it writes nothing.
 *
 * Written atomically: to a temp file beside it, flushed to the disk, then
 * renamed over it (tried again for a while when Windows says the file is
 * busy), and on POSIX the folder flushed after, so neither a crash nor a power
 * cut mid-write leaves anything but the previous state or the new one, whole.
 * A temp file is unique to its write (two app instances never share one),
 * removed when its write fails, and a write that lands clears what crashes
 * left (`clearStale`).
 *
 * Saved (`update`) without losing another process's save: every save stamps
 * the state with the next revision (`rev`), and just before its rename reads
 * the file again; when another process has saved since (another `rev`), the
 * patch is merged onto that newer state and tried again, UPDATE_ATTEMPTS times
 * at most. That leaves only the moment between that read and the rename. A
 * lock file would close it, but a crash leaves the lock behind, and a licence
 * that cannot be saved until someone deletes a file is worse for the paying
 * customer than a race that narrow.
 */
export function createFileStorage(
  filePath: string,
  options: { fs?: StorageFs; migrateFrom?: string; sleep?: (ms: number) => Promise<void> } = {},
): StorageAdapter {
  const fs = options.fs ?? nodeFs
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.`

  /** A whole state put in place, once `allowed` (when given) has not thrown, just before the rename. */
  const place = async (state: StoredState, allowed?: () => Promise<void>) => {
    const temp = await writeTemp(fs, dir, prefix, state)
    try {
      const renameIn = async () => {
        await allowed?.()
        await fs.rename(temp, filePath)
      }
      await retrying(renameIn, RENAME_BACKOFF_MS, busy, sleep)
    } catch (error) {
      await fs.rm(temp).catch(() => undefined)
      throw error
    }
    await fs.syncDir(dir).catch(() => undefined)
    await clearStale(fs, dir, prefix)
  }
  const write = (state: StoredState) => place(state)

  /** The state, and the revision of the FILE it was read from (none when it came from anywhere else). */
  const load = async (readOnly: boolean): Promise<{ state: StoredState | null; rev?: number }> => {
    const text = await readText(fs, filePath, sleep)
    if (text === null) {
      return { state: (await leftover(fs, dir, prefix)) ?? (await migrated(fs, options.migrateFrom, !readOnly, write)) }
    }
    try {
      const state = JSON.parse(text) as StoredState | null
      return { state, rev: state?.rev }
    } catch {
      if (readOnly) return { state: null }
      // Kept aside before anything is written in its place; a rename that
      // cannot be made throws, as a read that cannot be made does.
      await retrying(() => fs.rename(filePath, `${filePath}.${Date.now()}.corrupt`), RENAME_BACKOFF_MS, busy, sleep)
      await write({}).catch(() => undefined)
      await pruneCorrupt(fs, dir, prefix)
      return { state: null }
    }
  }

  /** Throws CONFLICT when the file's revision is no longer `rev`: another process saved since it was read. */
  const unchanged = async (rev: number | undefined) => {
    const text = await fs.readFile(filePath).catch((error: unknown) => {
      if (missing(codeOf(error))) return null
      throw error
    })
    if (revOf(text) === rev) return
    throw Object.assign(new Error('the state was saved by another process'), { code: CONFLICT })
  }

  return {
    read: async (opts) => (await load(opts?.readOnly === true)).state,
    write,
    async update(merge) {
      for (let attempt = 1; ; attempt += 1) {
        const base = await load(false)
        const next = { ...merge(base.state ?? {}), rev: (base.state?.rev ?? 0) + 1 }
        try {
          return await place(next, () => unchanged(base.rev))
        } catch (error) {
          if (codeOf(error) !== CONFLICT || attempt >= UPDATE_ATTEMPTS) throw error
        }
      }
    },
  }
}

/** The revision a file's text carries: none when missing or unstamped, NaN (equal to none) when it does not parse. */
function revOf(text: string | null): number | undefined {
  if (text === null) return undefined
  try {
    return (JSON.parse(text) as StoredState | null)?.rev
  } catch {
    return Number.NaN
  }
}

/**
 * The state an older SDK kept at `from` (relative to the working directory),
 * copied to the new path once (`copy`, false on a read-only read) and
 * returned; the old file is left where it is. Null when there is none, or it
 * does not parse. Never throws: a failed copy only means it is read again
 * next time.
 */
async function migrated(
  fs: StorageFs,
  from: string | undefined,
  copy: boolean,
  write: (state: StoredState) => Promise<void>,
): Promise<StoredState | null> {
  if (!from) return null
  try {
    const state = JSON.parse(await fs.readFile(from)) as StoredState
    if (copy) await write(state).catch(() => undefined)
    return state
  } catch {
    return null
  }
}
