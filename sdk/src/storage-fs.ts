import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import type { StoredState } from './types.js'

/**
 * The file operations under the default storage (storage.ts), and what it does
 * around them: tries again on a busy file, a temp file synced to the disk, and
 * the clearing of what crashes and corrupt files leave behind.
 */

/** A new file being written: what is written is flushed to the disk by `sync`. */
export interface StorageFile {
  write(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The file operations the storage uses: the real ones, or stand-ins in tests. */
export interface StorageFs {
  readFile(path: string): Promise<string>
  /** A new file to write, failing when there is one by that name. */
  create(path: string): Promise<StorageFile>
  rename(from: string, to: string): Promise<void>
  rm(path: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  mtimeMs(path: string): Promise<number>
  mkdir(dir: string): Promise<void>
  /** Flush a folder's entries (a rename in it) to the disk. */
  syncDir(dir: string): Promise<void>
}

export const nodeFs: StorageFs = {
  readFile: (path) => readFile(path, 'utf8'),
  create: async (path) => {
    const handle = await open(path, 'wx')
    return {
      write: (data) => handle.writeFile(data, 'utf8'),
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  rename: (from, to) => rename(from, to),
  rm: (path) => rm(path, { force: true }),
  readdir: (dir) => readdir(dir),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  syncDir: async (dir) => {
    // Windows opens no handle on a folder to flush; NTFS journals the rename itself.
    if (platform() === 'win32') return
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

/** Waits between tries of a read that failed other than for a missing file: about a second in all. */
export const READ_BACKOFF_MS = [50, 100, 200, 300, 350]

/** Waits between tries of a rename a busy file refused: about a second and a half in all. */
export const RENAME_BACKOFF_MS = [50, 100, 200, 400, 800]

/** Errors a busy file gives a rename on Windows (an antivirus scan, an indexer, a backup), worth another try. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])
export const busy = (code: string | undefined) => BUSY.has(code ?? '')
export const missing = (code: string | undefined) => code === 'ENOENT'

/** How many set-aside `.corrupt` files of a state file are kept: the newest. */
export const KEEP_CORRUPT = 3

/**
 * How old a temp file must be to be a crash's leftover rather than another app
 * instance's write in flight, which clearing would make fail.
 */
export const STALE_TEMP_MS = 60_000

/** `work`, tried again after each wait in `backoff` while its error is worth another try; the last error otherwise. */
export async function retrying<T>(
  work: () => Promise<T>,
  backoff: number[],
  worthAgain: (code: string | undefined) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (const wait of backoff) {
    try {
      return await work()
    } catch (error) {
      if (!worthAgain(codeOf(error))) throw error
      await sleep(wait)
    }
  }
  return work()
}

export function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** A file's text, tried again for about a second on any failure but a missing file; null when it is missing. */
export async function readText(
  fs: StorageFs,
  path: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  return retrying(() => fs.readFile(path), READ_BACKOFF_MS, (code) => !missing(code), sleep).catch((error: unknown) => {
    if (missing(codeOf(error))) return null
    throw error
  })
}

/**
 * A state written whole to a new temp file in `dir` and flushed to the disk
 * before it is closed: a rename of it after a power cut finds it whole, never
 * a name over data the disk had not yet been given. Removed when it fails.
 */
export async function writeTemp(fs: StorageFs, dir: string, prefix: string, state: StoredState): Promise<string> {
  await fs.mkdir(dir)
  const temp = join(dir, `${prefix}${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    const file = await fs.create(temp)
    try {
      await file.write(JSON.stringify(state))
      await file.sync()
    } finally {
      await file.close()
    }
    return temp
  } catch (error) {
    await fs.rm(temp).catch(() => undefined)
    throw error
  }
}

/** The newest temp file of a storage file that parses, when the file itself is missing. Never throws. */
export async function leftover(fs: StorageFs, dir: string, prefix: string): Promise<StoredState | null> {
  try {
    const temps = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    const dated = await Promise.all(temps.map(async (name) => ({ name, at: await fs.mtimeMs(join(dir, name)) })))
    for (const { name } of dated.sort((a, b) => b.at - a.at)) {
      try {
        return JSON.parse(await fs.readFile(join(dir, name))) as StoredState
      } catch {
        /* torn: the next older one */
      }
    }
    return null
  } catch {
    return null
  }
}

/** Remove a storage file's temp files older than STALE_TEMP_MS. Best-effort: never fails the write it follows. */
export async function clearStale(fs: StorageFs, dir: string, prefix: string): Promise<void> {
  try {
    const temps = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    const now = Date.now()
    for (const name of temps) {
      const path = join(dir, name)
      const at = await fs.mtimeMs(path).catch(() => now)
      if (now - at >= STALE_TEMP_MS) await fs.rm(path).catch(() => undefined)
    }
  } catch {
    /* left for the next write */
  }
}

/**
 * Remove all but the newest KEEP_CORRUPT set-aside files of a state file,
 * newest by the time in their name (when they were set aside; a rename keeps
 * the file's own mtime, which is when it was last written). Best-effort.
 */
export async function pruneCorrupt(fs: StorageFs, dir: string, prefix: string): Promise<void> {
  try {
    const aside = (await fs.readdir(dir))
      .map((name) => ({ name, at: /^(\d+)\.corrupt$/.exec(name.slice(prefix.length))?.[1] }))
      .filter((file): file is { name: string; at: string } => file.at !== undefined && file.name.startsWith(prefix))
      .sort((a, b) => Number(b.at) - Number(a.at))
    for (const { name } of aside.slice(KEEP_CORRUPT)) await fs.rm(join(dir, name)).catch(() => undefined)
  } catch {
    /* kept until the next one is set aside */
  }
}
