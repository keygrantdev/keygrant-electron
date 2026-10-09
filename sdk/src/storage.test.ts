import { describe, it, expect, afterEach, vi } from 'vitest'
import { link, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { OPEN_MAJOR, generateKeyPair, importSigningKey, signLease, type LeaseInput } from '@keygrant/shared'
import { License } from './license.js'
import { Engine } from './engine.js'
import { DEFAULT_HTTP_TIMEOUT_MS } from './adapters.js'
import {
  CONFLICT,
  KEEP_CORRUPT,
  STALE_TEMP_MS,
  UPDATE_ATTEMPTS,
  createFileStorage,
  defaultStoragePath,
  type StorageFs,
} from './storage.js'
import type { Fingerprinter, HttpAdapter, StoredState } from './types.js'
import type { Basis } from './offline.js'

afterEach(() => {
  vi.useRealTimers()
})

/** A temp folder for one test, removed after it. */
async function inTemp(test: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'keygrant-'))
  try {
    await test(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Waits that take no time, recorded: what a retry would have slept. */
function noSleep() {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => void slept.push(ms) }
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: the file system said no`), { code })
}

type Op = 'readFile' | 'create' | 'write' | 'sync' | 'close' | 'rename' | 'rm' | 'readdir' | 'mtimeMs' | 'mkdir' | 'syncDir'

/**
 * Files in memory, as one or more processes see them, with failures queued per
 * operation (`failNext`) or given every time (`failAlways`), an operation held
 * until released (`holdNext`), something another process does just before an
 * operation (`before`), each file's mtime (`mtimes`, else now), every
 * operation in order (`ops`), and every one that changes a file (`changes`).
 */
function memoryFs(files: Record<string, string> = {}) {
  const queued: Partial<Record<Op, string[]>> = {}
  const always: Partial<Record<Op, string>> = {}
  const holds: Partial<Record<Op, { held: Promise<void>; reached: boolean }[]>> = {}
  const before: Partial<Record<Op, () => void>> = {}
  const mtimes: Record<string, number> = {}
  const ops: string[] = []
  const changes: string[] = []
  const enter = async (op: Op, path: string, changing = false) => {
    before[op]?.()
    const hold = holds[op]?.shift()
    if (hold) {
      hold.reached = true
      await hold.held
    }
    const code = queued[op]?.shift() ?? always[op]
    if (code) throw errno(code)
    ops.push(`${op} ${path}`)
    if (changing) changes.push(`${op} ${path}`)
  }
  const fs: StorageFs = {
    async readFile(path) {
      await enter('readFile', path)
      const text = files[path]
      if (text === undefined) throw errno('ENOENT')
      return text
    },
    async create(path) {
      await enter('create', path, true)
      if (files[path] !== undefined) throw errno('EEXIST')
      files[path] = ''
      return {
        write: async (data) => {
          await enter('write', path, true)
          files[path] = data
        },
        sync: () => enter('sync', path),
        close: () => enter('close', path),
      }
    },
    async rename(from, to) {
      await enter('rename', `${from} ${to}`, true)
      const text = files[from]
      if (text === undefined) throw errno('ENOENT')
      files[to] = text
      delete files[from]
    },
    async rm(path) {
      await enter('rm', path, true)
      delete files[path]
    },
    async readdir(dir) {
      await enter('readdir', dir)
      return Object.keys(files)
        .filter((path) => dirname(path) === dir)
        .map((path) => path.slice(dir.length + 1))
    },
    async mtimeMs(path) {
      await enter('mtimeMs', path)
      return mtimes[path] ?? Date.now()
    },
    async mkdir(dir) {
      await enter('mkdir', dir)
    },
    async syncDir(dir) {
      await enter('syncDir', dir)
    },
  }
  return {
    fs,
    files,
    mtimes,
    ops,
    changes,
    before,
    failNext: (op: Op, ...codes: string[]) => {
      queued[op] = [...(queued[op] ?? []), ...codes]
    },
    failAlways: (op: Op, code: string) => {
      always[op] = code
    },
    /** Hold the next `op` until `release`; `reached` once something waits on it. */
    holdNext: (op: Op) => {
      let release: () => void = () => undefined
      const hold = {
        held: new Promise<void>((resolve) => {
          release = resolve
        }),
        reached: false,
      }
      holds[op] = [...(holds[op] ?? []), hold]
      return { release: () => release(), reached: () => hold.reached }
    },
  }
}

const STATE_DIR = join(tmpdir(), 'keygrant-memory')
const STATE = join(STATE_DIR, 'sluice.json')
const SAVED = JSON.stringify({ key: 'SLUICE-AAAA-BBBB-CCCC-DDDD', activationId: 'act_1', lastSeen: 1 })

describe('defaultStoragePath', () => {
  const windows = (env: Record<string, string>) => ({ platform: 'win32', homedir: 'C:\\Users\\jo', env })
  const linux = (env: Record<string, string>) => ({ platform: 'linux', homedir: '/home/jo', env })
  it.each([
    ['Windows', windows({ LOCALAPPDATA: 'C:\\Users\\jo\\AppData\\Local' }), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['Windows with %LOCALAPPDATA% elsewhere', windows({ LOCALAPPDATA: 'D:\\Profiles\\jo\\Local' }), 'D:\\Profiles\\jo\\Local\\KeyGrant\\sluice.json'],
    // Roaming AppData follows the user to every machine of a domain: one state
    // file shared by several machines would be "another device" on each in turn.
    ['Windows with only the roaming %APPDATA%', windows({ APPDATA: 'C:\\Users\\jo\\AppData\\Roaming' }), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['Windows with no %LOCALAPPDATA%', windows({}), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['Windows with an empty %LOCALAPPDATA%', windows({ LOCALAPPDATA: '' }), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['Windows with a relative %LOCALAPPDATA%', windows({ LOCALAPPDATA: 'AppData\\Local' }), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['Windows with a drive-relative %LOCALAPPDATA%', windows({ LOCALAPPDATA: 'C:Local' }), 'C:\\Users\\jo\\AppData\\Local\\KeyGrant\\sluice.json'],
    ['macOS', { platform: 'darwin', homedir: '/Users/jo', env: {} }, '/Users/jo/Library/Application Support/KeyGrant/sluice.json'],
    ['Linux with $XDG_CONFIG_HOME', linux({ XDG_CONFIG_HOME: '/home/jo/.cfg' }), '/home/jo/.cfg/keygrant/sluice.json'],
    ['Linux without it', linux({}), '/home/jo/.config/keygrant/sluice.json'],
    ['Linux with it empty', linux({ XDG_CONFIG_HOME: '' }), '/home/jo/.config/keygrant/sluice.json'],
    ['Linux with it relative', linux({ XDG_CONFIG_HOME: '.cfg' }), '/home/jo/.config/keygrant/sluice.json'],
  ])('keeps state per user on this machine on %s, never in the working directory', (_case, system, expected) => {
    expect(defaultStoragePath('sluice', system)).toBe(expected)
  })
})

describe('createFileStorage: writes', () => {
  it('writes by renaming a temp file over the state, and leaves no temp behind', () =>
    inTemp(async (dir) => {
      const path = join(dir, 'sluice.json')
      const storage = createFileStorage(path)
      await storage.write({ key: 'K', lastSeen: 1 })
      await storage.write({ key: 'K', lastSeen: 2 })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ key: 'K', lastSeen: 2 })
      expect(await readdir(dir)).toEqual(['sluice.json'])
    }))

  it('replaces the state rather than writing into it: a link to the old state keeps the old state', () =>
    inTemp(async (dir) => {
      // A write in place changes the one file every name for it shares; a
      // rename puts a new file under the name and leaves the old one whole.
      const path = join(dir, 'sluice.json')
      const storage = createFileStorage(path)
      await storage.write({ key: 'K', lastSeen: 1 })
      await link(path, join(dir, 'old-state'))
      await storage.write({ key: 'K', lastSeen: 2 })
      expect(JSON.parse(await readFile(join(dir, 'old-state'), 'utf8'))).toEqual({ key: 'K', lastSeen: 1 })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ key: 'K', lastSeen: 2 })
    }))

  it("clears the temps crashes left once a write lands, and not another instance's write in flight", () =>
    inTemp(async (dir) => {
      const path = join(dir, 'sluice.json')
      const old = (Date.now() - 2 * STALE_TEMP_MS) / 1000
      await writeFile(join(dir, 'sluice.json.1.1.crashed.tmp'), JSON.stringify({ key: 'CRASHED' }), 'utf8')
      await utimes(join(dir, 'sluice.json.1.1.crashed.tmp'), old, old)
      await writeFile(join(dir, 'sluice.json.2.2.inflight.tmp'), '{"key":"IN', 'utf8')
      // Another product's temp in the same folder is not this file's to clear.
      await writeFile(join(dir, 'maindeck.json.3.3.other.tmp'), '{}', 'utf8')
      await utimes(join(dir, 'maindeck.json.3.3.other.tmp'), old, old)
      // Either side of the cutoff, five seconds each way.
      const aged = (ms: number) => (Date.now() - ms) / 1000
      await writeFile(join(dir, 'sluice.json.4.4.younger.tmp'), '{}', 'utf8')
      await utimes(join(dir, 'sluice.json.4.4.younger.tmp'), aged(STALE_TEMP_MS - 5_000), aged(STALE_TEMP_MS - 5_000))
      await writeFile(join(dir, 'sluice.json.5.5.older.tmp'), '{}', 'utf8')
      await utimes(join(dir, 'sluice.json.5.5.older.tmp'), aged(STALE_TEMP_MS + 5_000), aged(STALE_TEMP_MS + 5_000))

      await createFileStorage(path).write({ key: 'K' })
      expect((await readdir(dir)).sort()).toEqual([
        'maindeck.json.3.3.other.tmp',
        'sluice.json',
        'sluice.json.2.2.inflight.tmp',
        'sluice.json.4.4.younger.tmp',
      ])
      // The minute the integration guide promises.
      expect(STALE_TEMP_MS).toBe(60_000)
    }))

  it('clears a temp aged exactly the cutoff, and keeps one a millisecond younger', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_757_000_000_000)
    const memory = memoryFs({ [STATE]: SAVED, [`${STATE}.1.1.edge.tmp`]: '{}', [`${STATE}.2.2.inside.tmp`]: '{}' })
    memory.mtimes[`${STATE}.1.1.edge.tmp`] = Date.now() - STALE_TEMP_MS
    memory.mtimes[`${STATE}.2.2.inside.tmp`] = Date.now() - STALE_TEMP_MS + 1
    await createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep }).write({ key: 'K' })
    expect(Object.keys(memory.files).sort()).toEqual([STATE, `${STATE}.2.2.inside.tmp`])
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('tries a rename Windows refuses as busy again: refused twice with %s, then made', async (code) => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failNext('rename', code, code)
    const { slept, sleep } = noSleep()
    await createFileStorage(STATE, { fs: memory.fs, sleep }).write({ key: 'K', lastSeen: 2 })
    expect(JSON.parse(memory.files[STATE] ?? '')).toEqual({ key: 'K', lastSeen: 2 })
    expect(slept).toHaveLength(2)
    expect(Object.keys(memory.files)).toEqual([STATE])
  })

  it('gives up on a rename that stays busy after a second or two, keeping the state and removing its temp', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failAlways('rename', 'EBUSY')
    const { slept, sleep } = noSleep()
    await expect(createFileStorage(STATE, { fs: memory.fs, sleep }).write({ key: 'K' })).rejects.toMatchObject({ code: 'EBUSY' })
    const waited = slept.reduce((sum, ms) => sum + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(1_000)
    expect(waited).toBeLessThanOrEqual(2_000)
    expect(memory.files).toEqual({ [STATE]: SAVED })
  })

  it('does not try again a rename that failed other than for a busy file', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failNext('rename', 'ENOSPC')
    const { slept, sleep } = noSleep()
    await expect(createFileStorage(STATE, { fs: memory.fs, sleep }).write({ key: 'K' })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(slept).toEqual([])
    expect(memory.files).toEqual({ [STATE]: SAVED })
  })

  it('flushes the temp to the disk and closes it before the rename, and the folder after it', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    await createFileStorage(STATE, { fs: memory.fs }).write({ key: 'K' })
    const steps = memory.ops.map((op) => op.split(' ')[0]).filter((op) => !['readdir', 'mtimeMs', 'mkdir'].includes(op ?? ''))
    expect(steps).toEqual(['create', 'write', 'sync', 'close', 'rename', 'syncDir'])
  })

  it('fails a write whose temp cannot be flushed, the state as it was and no temp', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failNext('sync', 'EIO')
    await expect(createFileStorage(STATE, { fs: memory.fs }).write({ key: 'K' })).rejects.toMatchObject({ code: 'EIO' })
    expect(memory.files).toEqual({ [STATE]: SAVED })
  })

  it('fails nothing when the folder cannot be flushed: the rename has landed', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failNext('syncDir', 'EINVAL')
    await createFileStorage(STATE, { fs: memory.fs }).write({ key: 'K' })
    expect(memory.files).toEqual({ [STATE]: JSON.stringify({ key: 'K' }) })
  })

  it('leaves the state as it was, and no temp, when a write fails', () =>
    inTemp(async (dir) => {
      // The state path is a folder: the rename over it fails (EPERM on Windows, tried again).
      const path = join(dir, 'sluice.json')
      await mkdir(path)
      await expect(createFileStorage(path, { sleep: noSleep().sleep }).write({ key: 'K' })).rejects.toThrow()
      expect(await readdir(dir)).toEqual(['sluice.json'])
    }))
})

describe('createFileStorage: reads', () => {
  it('returns null when the file does not exist, then round-trips state', () =>
    inTemp(async (dir) => {
      const storage = createFileStorage(join(dir, 'nested', 'license.json'))
      expect(await storage.read()).toBeNull()
      await storage.write({ key: 'K', activationId: 'a', lastSeen: 42 })
      expect(await storage.read()).toEqual({ key: 'K', activationId: 'a', lastSeen: 42 })
    }))

  it('reads the state it had when a write crashed before its rename: the temp is there, the state whole', () =>
    inTemp(async (dir) => {
      const path = join(dir, 'sluice.json')
      await createFileStorage(path).write({ key: 'OLD', lastSeen: 1 })
      // A write that got as far as half its temp file.
      await writeFile(join(dir, 'sluice.json.123.456.abc.tmp'), '{"key":"NE', 'utf8')
      expect(await createFileStorage(path).read()).toEqual({ key: 'OLD', lastSeen: 1 })
    }))

  it('reads the newest temp that parses when the state itself is missing, by its time, not its name', () =>
    inTemp(async (dir) => {
      const path = join(dir, 'sluice.json')
      const at = (seconds: number) => Date.now() / 1000 - seconds
      // Written in the opposite order to their times, and named so that their
      // names sort the opposite way too: only the times can tell them apart.
      const newer = join(dir, 'sluice.json.1.1.a.tmp')
      const older = join(dir, 'sluice.json.9.9.z.tmp')
      const torn = join(dir, 'sluice.json.5.5.m.tmp')
      await writeFile(newer, JSON.stringify({ key: 'NEW' }), 'utf8')
      await writeFile(older, JSON.stringify({ key: 'OLD' }), 'utf8')
      await writeFile(torn, '{"key":"TOR', 'utf8')
      await utimes(older, at(30), at(30))
      await utimes(newer, at(20), at(20))
      await utimes(torn, at(10), at(10))
      expect(await createFileStorage(path).read()).toEqual({ key: 'NEW' })
      await rm(newer)
      expect(await createFileStorage(path).read()).toEqual({ key: 'OLD' })
      await rm(older)
      expect(await createFileStorage(path).read()).toBeNull()
    }))

  it('sets a file that does not parse aside and starts afresh, never from a temp', () =>
    inTemp(async (dir) => {
      const path = join(dir, 'sluice.json')
      await writeFile(path, '{"key":"SLUICE-AA', 'utf8')
      await writeFile(join(dir, 'sluice.json.1.1.a.tmp'), JSON.stringify({ key: 'FROM-A-TEMP' }), 'utf8')
      const storage = createFileStorage(path)
      expect(await storage.read()).toBeNull()

      const names = await readdir(dir)
      const aside = names.find((name) => /^sluice\.json\.\d+\.corrupt$/.test(name)) ?? 'none set aside'
      expect(await readFile(join(dir, aside), 'utf8')).toBe('{"key":"SLUICE-AA')
      // An empty state in its place, so no later read takes the temp instead.
      expect(await storage.read()).toEqual({})
    }))

  it('keeps only the newest set-aside files of a state file, by the time in their names', async () => {
    const aside = (at: number) => `${STATE}.${at}.corrupt`
    // 900 sorts after 3000 as text: only the numbers tell which is newest.
    // `tunnel.json.` is as long as `sluice.json.`: what follows it would read as a time.
    const others = { [join(STATE_DIR, 'tunnel.json.100.corrupt')]: 'x', [`${STATE}.notes.corrupt`]: 'x' }
    const memory = memoryFs({ [STATE]: '{"bad', [aside(900)]: 'x', [aside(1000)]: 'x', [aside(2000)]: 'x', [aside(3000)]: 'x', ...others })
    expect(await createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep }).read()).toBeNull()
    const kept = Object.keys(memory.files).filter((name) => /sluice\.json\.\d+\.corrupt$/.test(name))
    expect(kept).toHaveLength(KEEP_CORRUPT)
    expect(kept).toEqual(expect.arrayContaining([aside(3000), aside(2000)]))
    expect(memory.files[aside(1000)]).toBeUndefined()
    expect(memory.files[aside(900)]).toBeUndefined()
    // Another product's, and a name that is not a set-aside one, are not this file's to clear.
    expect(memory.files).toMatchObject(others)
  })

  it('reads read-only without repairing: a file that does not parse is no state, and stays as it is', async () => {
    const memory = memoryFs({ [STATE]: '{"bad' })
    expect(await createFileStorage(STATE, { fs: memory.fs }).read({ readOnly: true })).toBeNull()
    expect(memory.files).toEqual({ [STATE]: '{"bad' })
    expect(memory.changes).toEqual([])
  })

  it('tries a read that failed again: busy once, then the state', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failNext('readFile', 'EBUSY')
    const { slept, sleep } = noSleep()
    expect(await createFileStorage(STATE, { fs: memory.fs, sleep }).read()).toEqual(JSON.parse(SAVED))
    expect(slept).toHaveLength(1)
  })

  it.each(['EBUSY', 'EACCES', 'EIO'])(
    'throws on a read that still fails (%s) after about a second, rather than reading no state or a temp',
    async (code) => {
      const memory = memoryFs({ [STATE]: SAVED, [`${STATE}.1.1.a.tmp`]: JSON.stringify({ key: 'FROM-A-TEMP' }) })
      memory.failAlways('readFile', code)
      const { slept, sleep } = noSleep()
      await expect(createFileStorage(STATE, { fs: memory.fs, sleep }).read()).rejects.toMatchObject({ code })
      const waited = slept.reduce((sum, ms) => sum + ms, 0)
      expect(waited).toBeGreaterThanOrEqual(500)
      expect(waited).toBeLessThanOrEqual(1_500)
      expect(memory.changes).toEqual([])
    },
  )

  it('does not wait on a missing file', async () => {
    const { slept, sleep } = noSleep()
    expect(await createFileStorage(STATE, { fs: memoryFs().fs, sleep }).read()).toBeNull()
    expect(slept).toEqual([])
  })

  it('throws, writing nothing, when a file that does not parse cannot be set aside', async () => {
    const memory = memoryFs({ [STATE]: '{"key":"SLUICE-AA' })
    memory.failAlways('rename', 'EBUSY')
    await expect(createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep }).read()).rejects.toMatchObject({
      code: 'EBUSY',
    })
    expect(memory.files).toEqual({ [STATE]: '{"key":"SLUICE-AA' })
  })

  it('on a read that stays busy: status() is unknown, activate() rejects, nothing asked or written', async () => {
    // Every save is read, patch, write: a read taken as "no state" would be
    // written back over the licence. And an app awaits status() at launch: a
    // rejection there is no window at all.
    const memory = memoryFs({ [STATE]: SAVED })
    memory.failAlways('readFile', 'EBUSY')
    const asked: string[] = []
    const license = await licenseOver(memory, asked)

    expect(await license.status()).toEqual({ state: 'unknown', reason: 'storage' })
    expect(await license.refresh()).toEqual({ state: 'unknown', reason: 'storage' })
    expect(await license.startTrial()).toEqual({ state: 'unknown', reason: 'storage' })
    await expect(license.activate('SLUICE-EEEE-FFFF-GGGG-HHHH')).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(license.deactivate()).rejects.toMatchObject({ code: 'EBUSY' })
    expect(asked).toEqual([])
    expect(memory.files).toEqual({ [STATE]: SAVED })
    expect(memory.changes).toEqual([])
  })
})

describe('createFileStorage: the state an older SDK kept', () => {
  it('is copied to the new path once and read from there after, the old file left where it was', () =>
    inTemp(async (dir) => {
      const legacy = join(dir, 'app', '.keygrant', 'sluice.json')
      const path = join(dir, 'user', 'sluice.json')
      await mkdir(dirname(legacy), { recursive: true })
      await writeFile(legacy, SAVED, 'utf8')
      const storage = createFileStorage(path, { migrateFrom: legacy })

      expect(await storage.read()).toEqual(JSON.parse(SAVED))
      expect(await readFile(path, 'utf8')).toBe(SAVED)
      expect(await readFile(legacy, 'utf8')).toBe(SAVED)
      // From then on only the new path: a later change to the old file is not read.
      await writeFile(legacy, JSON.stringify({ key: 'CHANGED' }), 'utf8')
      expect(await storage.read()).toEqual(JSON.parse(SAVED))
    }))

  it('is ignored when the new path has a state', () =>
    inTemp(async (dir) => {
      const legacy = join(dir, '.keygrant', 'sluice.json')
      const path = join(dir, 'user', 'sluice.json')
      await mkdir(dirname(legacy), { recursive: true })
      await writeFile(legacy, SAVED, 'utf8')
      await createFileStorage(path).write({ key: 'NEWER' })
      expect(await createFileStorage(path, { migrateFrom: legacy }).read()).toEqual({ key: 'NEWER' })
    }))

  it('is no state, and nothing written, when it is missing or does not parse', () =>
    inTemp(async (dir) => {
      const legacy = join(dir, '.keygrant', 'sluice.json')
      const path = join(dir, 'user', 'sluice.json')
      expect(await createFileStorage(path, { migrateFrom: legacy }).read()).toBeNull()
      await mkdir(dirname(legacy), { recursive: true })
      await writeFile(legacy, '{"key":"SLU', 'utf8')
      expect(await createFileStorage(path, { migrateFrom: legacy }).read()).toBeNull()
      expect(await readdir(dir)).toEqual(['.keygrant'])
    }))

  it('is still read when it cannot be copied, and copied at a later read', async () => {
    const legacy = join(tmpdir(), 'keygrant-legacy', 'sluice.json')
    const memory = memoryFs({ [legacy]: SAVED })
    memory.failNext('write', 'ENOSPC')
    const storage = createFileStorage(STATE, { fs: memory.fs, migrateFrom: legacy, sleep: noSleep().sleep })
    expect(await storage.read()).toEqual(JSON.parse(SAVED))
    expect(memory.files[STATE]).toBeUndefined()
    expect(await storage.read()).toEqual(JSON.parse(SAVED))
    expect(memory.files[STATE]).toBe(SAVED)
  })

  it('is read, not copied, by a read-only read', async () => {
    const legacy = join(tmpdir(), 'keygrant-legacy', 'sluice.json')
    const memory = memoryFs({ [legacy]: SAVED })
    const storage = createFileStorage(STATE, { fs: memory.fs, migrateFrom: legacy })
    expect(await storage.read({ readOnly: true })).toEqual(JSON.parse(SAVED))
    expect(memory.changes).toEqual([])
  })
})

/** A License over the default storage on `memory`, recording what it asks the server. */
async function licenseOver(memory: ReturnType<typeof memoryFs>, asked: string[], migrateFrom?: string) {
  const storage = createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep, ...(migrateFrom ? { migrateFrom } : {}) })
  const { publicJwk } = await generateKeyPair()
  const http: HttpAdapter = {
    async post(url) {
      asked.push(url)
      return { status: 503, json: {} }
    },
  }
  const fingerprint = { get: async () => 'fp-test' }
  return new License({ product: 'sluice', apiBaseUrl: 'https://api.test', publicJwk, adapters: { storage, http, fingerprint } })
}

describe('a status() behind a call that has not finished', () => {
  /** A status() stuck on its read, and time past its grace: the next call runs read-only. */
  async function behindAStuckRead(memory: ReturnType<typeof memoryFs>, migrateFrom?: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const license = await licenseOver(memory, [], migrateFrom)
    const stuck = memory.holdNext('readFile')
    void license.status()
    for (let i = 0; i < 1000 && !stuck.reached(); i++) await new Promise((r) => setImmediate(r))
    const later = license.status()
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS + 15_000)
    return { answer: await later, release: stuck.release }
  }

  it('does not set a file that does not parse aside, nor write in its place', async () => {
    const memory = memoryFs({ [STATE]: '{"bad' })
    const { answer, release } = await behindAStuckRead(memory)
    expect(answer).toEqual({ state: 'unlicensed', stalled: true })
    expect(memory.changes).toEqual([])
    release()
  })

  it("reads an older SDK's state without copying it", async () => {
    const legacy = join(tmpdir(), 'keygrant-legacy', 'sluice.json')
    const trial = { trialStart: Date.now() - 86_400_000, trialEndsAt: Date.now() + 13 * 86_400_000 }
    const memory = memoryFs({ [legacy]: JSON.stringify(trial) })
    const { answer, release } = await behindAStuckRead(memory, legacy)
    // Read, and answered from (a stored end with no trial lease runs no trial).
    expect(answer).toMatchObject({ state: 'expired', reason: 'trial', stalled: true })
    expect(memory.changes).toEqual([])
    release()
  })

  it("makes the upgrade link from an older SDK's state without copying it, beside any call", async () => {
    const legacy = join(tmpdir(), 'keygrant-legacy', 'sluice.json')
    const memory = memoryFs({ [legacy]: SAVED })
    const license = await licenseOver(memory, [], legacy)
    expect(await license.upgradeUrl('https://buy.test/upgrade')).toBe('https://buy.test/upgrade?client_reference_id=act_1')
    expect(memory.changes).toEqual([])
  })

  it('is unknown, still writing nothing, when the state cannot be read', async () => {
    const memory = memoryFs({ [STATE]: SAVED })
    // The stuck read is held first, then fails like every read after it.
    memory.failAlways('readFile', 'EBUSY')
    const { answer, release } = await behindAStuckRead(memory)
    expect(answer).toEqual({ state: 'unknown', reason: 'storage', stalled: true })
    expect(memory.changes).toEqual([])
    release()
  })
})

/** The engine's own save, as a License makes it: one engine per app process. */
class Saver extends Engine {
  /** A save, based on `basis` (an answer to an ask, a note about an activation, a trial answer). */
  patch(patch: Partial<StoredState>, basis?: Basis): Promise<void> {
    return this.save(patch, undefined, basis)
  }
}

async function saverOver(memory: ReturnType<typeof memoryFs>): Promise<Saver> {
  const storage = createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep })
  const { publicJwk } = await generateKeyPair()
  return new Saver({ product: 'sluice', apiBaseUrl: 'https://api.test', publicJwk, adapters: { storage } })
}

describe('saves from more than one process', () => {
  it('stamps every save with the next revision', async () => {
    const memory = memoryFs()
    const saver = await saverOver(memory)
    await saver.patch({ key: 'K' })
    expect(JSON.parse(memory.files[STATE] ?? '')).toMatchObject({ key: 'K', rev: 1 })
    await saver.patch({ checkedMajor: 2 })
    expect(JSON.parse(memory.files[STATE] ?? '')).toMatchObject({ key: 'K', checkedMajor: 2, rev: 2 })
  })

  it.each([
    ['a stamped state', { [STATE]: JSON.stringify({ key: 'K', rev: 4 }) }],
    ["an older SDK's state, never stamped", { [STATE]: JSON.stringify({ key: 'K' }) }],
    ['no state yet', {}],
  ])('loses neither of two saves that interleave, onto %s', async (_case, files) => {
    const memory = memoryFs({ ...files })
    const [a, b] = [await saverOver(memory), await saverOver(memory)]
    // A has read the state and is about to write it; B saves in between.
    const held = memory.holdNext('create')
    const first = a.patch({ keptMajor: 2 })
    for (let i = 0; i < 1000 && !held.reached(); i++) await new Promise((r) => setImmediate(r))
    await b.patch({ checkedMajor: 3 })
    held.release()
    await first

    expect(JSON.parse(memory.files[STATE] ?? '')).toMatchObject({ keptMajor: 2, checkedMajor: 3 })
    expect(Object.keys(memory.files)).toEqual([STATE])
  })

  // A field another process REMOVED stays removed: the patch is merged again
  // onto its state, never the whole state this one first made.
  it.each([
    ['B clears the refusal', { refused: undefined }, undefined, { keptMajor: 2 }, undefined, ['refused']],
    ['B drops the key', { key: undefined, activationId: undefined }, undefined, { keptMajor: 2 }, undefined, ['key', 'activationId']],
    [
      "B's answer, asked for later, clears the refusal A's older answer would set again",
      { lease: 'L2', refused: undefined },
      { at: 2_000, activationId: 'act_1', seen: 100 },
      { keptMajor: 2, refused: 'revoked' as const, lease: undefined },
      { at: 1_000, activationId: 'act_1', seen: 100 },
      ['refused'],
    ],
  ])('keeps what another process removed in between: %s', async (_case, bPatch, bAsked, aPatch, aAsked, gone) => {
    const memory = memoryFs({
      [STATE]: JSON.stringify({ key: 'K', activationId: 'act_1', refused: 'revoked', verdictAt: 100, rev: 4 }),
    })
    const [a, b] = [await saverOver(memory), await saverOver(memory)]
    const held = memory.holdNext('create')
    const first = a.patch(aPatch, aAsked && { answer: aAsked })
    for (let i = 0; i < 1000 && !held.reached(); i++) await new Promise((r) => setImmediate(r))
    await b.patch(bPatch, bAsked && { answer: bAsked })
    held.release()
    await first

    const saved = JSON.parse(memory.files[STATE] ?? '') as Record<string, unknown>
    expect(saved).toMatchObject({ keptMajor: 2 })
    for (const field of gone) expect(saved).not.toHaveProperty(field)
    if (bAsked) expect(saved).toMatchObject({ lease: 'L2', verdictAt: 2_000 })
  })

  it('keeps the higher kept major another process noted in between', async () => {
    const memory = memoryFs({ [STATE]: JSON.stringify({ key: 'K', activationId: 'act_1', keptMajor: 2, rev: 1 }) })
    const [a, b] = [await saverOver(memory), await saverOver(memory)]
    const about = { about: { activationId: 'act_1' } }
    const held = memory.holdNext('create')
    const first = a.patch({ keptMajor: 3 }, about)
    for (let i = 0; i < 1000 && !held.reached(); i++) await new Promise((r) => setImmediate(r))
    await b.patch({ keptMajor: 5 }, about)
    held.release()
    await first
    expect(JSON.parse(memory.files[STATE] ?? '')).toMatchObject({ keptMajor: 5 })
  })

  it("fails with CONFLICT after a few tries when the state keeps changing under it, keeping the other's", async () => {
    const memory = memoryFs({ [STATE]: JSON.stringify({ key: 'K', rev: 1 }) })
    let other = 1
    // Another process saves every time this one has read and is about to write.
    memory.before.create = () => {
      other += 1
      memory.files[STATE] = JSON.stringify({ key: 'OTHER', rev: other })
    }
    const saver = await saverOver(memory)
    await expect(saver.patch({ keptMajor: 2 })).rejects.toMatchObject({ code: CONFLICT })
    expect(memory.ops.filter((op) => op.startsWith('create'))).toHaveLength(UPDATE_ATTEMPTS)
    expect(UPDATE_ATTEMPTS).toBe(5)
    expect(JSON.parse(memory.files[STATE] ?? '')).toEqual({ key: 'OTHER', rev: other })
    expect(Object.keys(memory.files)).toEqual([STATE])
  })
})

describe('answers saved by two instances of the app', () => {
  const KEY = 'SLUICE-AAAA-BBBB-CCCC-DDDD'
  const NOW = 1_757_000_000_000
  const DAY = 86_400_000
  type Answers = Record<string, { status: number; json: unknown }>

  /** One state file, a signing key, and instances of the app over them. */
  async function onOneFile(stored: (sign: (at: number, claims?: Partial<LeaseInput>) => Promise<string>) => Promise<StoredState>) {
    const { publicJwk, privateJwk } = await generateKeyPair()
    const signingKey = await importSigningKey(privateJwk)
    const base: LeaseInput = { sub: KEY, product: 'sluice', aid: 'act_1', model: 'perpetual', lim: 3, major: 1, ent: {}, ttlSeconds: 30 * 24 * 3600 }
    const sign = (at: number, claims: Partial<LeaseInput> = {}) => signLease({ ...base, ...claims }, signingKey, at)
    const memory = memoryFs({ [STATE]: JSON.stringify(await stored(sign)) })
    /** An instance whose clock reads `now`, whose server answers each action as `answers` says. */
    const instance = (now: number, answers: Answers, fingerprint: Fingerprinter = { get: async () => 'fp-test' }) =>
      new License({
        product: 'sluice',
        apiBaseUrl: 'https://api.test',
        publicJwk,
        adapters: {
          storage: createFileStorage(STATE, { fs: memory.fs, sleep: noSleep().sleep }),
          http: { post: async (url) => answers[url.split('/').pop() ?? ''] ?? { status: 404, json: {} } },
          clock: { now: () => now },
          fingerprint,
        },
      })
    /** `first` held at its first save until `between` has run, then let finish. */
    async function interleave<T>(first: () => Promise<T>, between: () => Promise<void>): Promise<T> {
      const saving = memory.holdNext('create')
      const running = first()
      for (let i = 0; i < 1000 && !saving.reached(); i++) await new Promise((r) => setImmediate(r))
      await between()
      saving.release()
      return running
    }
    const saved = () => JSON.parse(memory.files[STATE] ?? '') as StoredState
    return { sign, memory, instance, interleave, saved }
  }

  it("keeps the newer answer: a refusal asked for later survives the re-merge of an older ask's lease", async () => {
    const file = await onOneFile(async (sign) => ({
      key: KEY,
      activationId: 'act_1',
      lease: await sign(NOW - DAY),
      checkedMajor: 1,
      lastSeen: NOW - DAY,
      rev: 1,
    }))
    // A asks first and is answered with a lease; B asks a second later and is refused.
    const a = file.instance(NOW, { validate: { status: 200, json: { lease: await file.sign(NOW), activationId: 'act_1' } } })
    const b = file.instance(NOW + 1_000, { validate: { status: 403, json: { error: 'revoked' } } })

    // A has its answer and has read the state to save it; B saves first.
    const answered = await file.interleave(
      () => a.refresh(),
      async () => {
        expect(await b.refresh()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
      },
    )
    expect(answered).toEqual({ state: 'licensed', key: KEY })
    expect(file.saved()).toMatchObject({ refused: 'revoked', verdictAt: NOW + 1_000 })
    expect(file.saved().lease).toBeUndefined()
    expect(file.memory.ops.filter((op) => op.startsWith('create'))).toHaveLength(3)
  })

  it("keeps the later ask's answer when the clock was put back between the two asks", async () => {
    const file = await onOneFile(async (sign) => ({
      key: KEY,
      activationId: 'act_1',
      lease: await sign(NOW - DAY),
      checkedMajor: 1,
      lastSeen: NOW - DAY,
      rev: 1,
    }))
    const a = file.instance(NOW, { validate: { status: 200, json: { lease: await file.sign(NOW), activationId: 'act_1' } } })
    // B asks after the clock was put back a minute: its own clock reads earlier than A's ask.
    const b = file.instance(NOW - 60_000, { validate: { status: 403, json: { error: 'revoked' } } })

    await file.interleave(
      () => a.refresh(),
      async () => {
        // A save made at NOW + 2 s, before the clock went back, raised the guard.
        const raised = { ...file.saved(), lastSeen: NOW + 2_000, rev: (file.saved().rev ?? 0) + 1 }
        file.memory.files[STATE] = JSON.stringify(raised)
        await b.refresh()
      },
    )
    // Stamped by the guarded clock, B's answer still reads as the later one.
    expect(file.saved()).toMatchObject({ refused: 'revoked', verdictAt: NOW + 2_000 })
    expect(file.saved().lease).toBeUndefined()
  })

  it('keeps a refusal asked for later over a re-activation of the same seat that saves after it', async () => {
    const file = await onOneFile(async (sign) => ({
      key: KEY,
      activationId: 'act_1',
      lease: await sign(NOW - DAY),
      checkedMajor: 1,
      lastSeen: NOW - DAY,
      rev: 1,
    }))
    // W1 activates the key again (the same seat) at NOW; W2 renews it a second later and is refused.
    const w1 = file.instance(NOW, { activate: { status: 200, json: { lease: await file.sign(NOW), activationId: 'act_1' } } })
    const w2 = file.instance(NOW + 1_000, { validate: { status: 403, json: { error: 'revoked' } } })

    const activated = await file.interleave(
      () => w1.activate(KEY),
      async () => {
        expect(await w2.refresh()).toEqual({ state: 'invalid', reason: 'revoked', key: KEY })
      },
    )
    expect(activated).toEqual({ ok: true })
    expect(file.saved()).toMatchObject({ key: KEY, activationId: 'act_1', refused: 'revoked', verdictAt: NOW + 1_000 })
    expect(file.saved().lease).toBeUndefined()
    // So the revoked device does not license offline.
    expect(await w1.status()).toMatchObject({ state: 'invalid', reason: 'revoked' })
  })

  describe('a renewal that lands after the activation it renewed is gone', () => {
    /** W2's licence: an open lease inside its upgrade window, so a check-in notes the major it ran. */
    const open = { major: OPEN_MAJOR, upgradeUntil: Math.floor((NOW + 10 * DAY) / 1000) }
    const machine: Fingerprinter = {
      get: async () => 'fp-machine',
      identify: async () => ({ fingerprint: 'fp-machine', kind: 'machine', alternates: [] }),
    }

    it.each([
      ['W1 deactivated', 'deactivate'],
      ['W1 activated another key', 'activate'],
    ] as const)('writes nothing of it, no kept major and no install memory: %s', async (_case, action) => {
      const file = await onOneFile(async (sign) => ({
        key: KEY,
        activationId: 'act_1',
        lease: await sign(NOW - DAY, open),
        checkedMajor: 1,
        lastSeen: NOW - DAY,
        rev: 1,
      }))
      const leaseB = await file.sign(NOW, { sub: 'SLUICE-BBBB-BBBB-BBBB-BBBB', aid: 'act_2' })
      const w1 = file.instance(NOW, {
        deactivate: { status: 200, json: { ok: true } },
        activate: { status: 200, json: { lease: leaseB, activationId: 'act_2' } },
      })
      const w2 = file.instance(NOW, { validate: { status: 200, json: { lease: await file.sign(NOW, open), activationId: 'act_1' } } }, machine)

      await file.interleave(
        () => w2.refresh(),
        async () => {
          if (action === 'deactivate') await w1.deactivate()
          else expect(await w1.activate('SLUICE-BBBB-BBBB-BBBB-BBBB')).toEqual({ ok: true })
        },
      )
      const saved = file.saved()
      expect(saved.keptMajor).toBeUndefined()
      expect(saved.deviceKind).toBeUndefined()
      if (action === 'deactivate') expect(saved.key).toBeUndefined()
      else expect(saved).toMatchObject({ key: 'SLUICE-BBBB-BBBB-BBBB-BBBB', activationId: 'act_2', lease: leaseB })
    })
  })
})
