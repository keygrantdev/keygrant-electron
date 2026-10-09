import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchHttp,
  hashFingerprint,
  hostnameFingerprint,
  nodeFingerprinter,
  noopRegistry,
  systemClock,
} from './adapters.js'
import { BOOT_SLACK_MS, MACHINE_ID_TIMEOUT_MS, readMachineId, type MachineIdSource } from './machine-id.js'

describe('hashFingerprint', () => {
  it('is deterministic and distinguishes inputs', () => {
    expect(hashFingerprint('abc')).toBe(hashFingerprint('abc'))
    expect(hashFingerprint('abc')).not.toBe(hashFingerprint('def'))
    expect(hashFingerprint('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('nodeFingerprinter', () => {

  type Run = { command: string; args: string[]; timeoutMs: number }

  /** An error as `execFile` and `fs` reject with. */
  function failure(fields: { code?: string | number; killed?: boolean; signal?: string }) {
    return Object.assign(new Error('failed'), fields)
  }

  /**
   * A stand-in system: what each command prints (or how it fails), what each
   * file holds (or how reading it fails). Anything not named is not there.
   */
  function system(
    platform: string,
    outputs: Record<string, string | Error> = {},
    files: Record<string, string | Error> = {},
  ): MachineIdSource & { runs: Run[] } {
    const runs: Run[] = []
    return {
      platform,
      systemRoot: 'C:\\Windows',
      runs,
      async run(command, args, timeoutMs) {
        runs.push({ command, args, timeoutMs })
        const out = outputs[command]
        if (out === undefined) throw failure({ code: 'ENOENT' })
        if (out instanceof Error) throw out
        return out
      },
      async readFile(path) {
        const text = files[path]
        if (text === undefined) throw failure({ code: 'ENOENT' })
        if (text instanceof Error) throw text
        return text
      },
    }
  }

  const REG = 'C:\\Windows\\System32\\reg.exe'
  const IOREG = '/usr/sbin/ioreg'
  const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  const regOutput = (gap: string) =>
    ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', `${gap}MachineGuid${gap}REG_SZ${gap}${GUID}`, ''].join('\r\n')
  const MAC_OUTPUT = [
    '+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000110, registered>',
    '    {',
    '      "IOPlatformSerialNumber" = "C02XXXXXXX"',
    '      "IOPlatformUUID" = "564D8A1C-3F6E-4E3B-9F2A-1B2C3D4E5F60"',
    '    }',
  ].join('\n')
  const fallback = hostnameFingerprint()

  it('reads the Windows MachineGuid with reg.exe by absolute path, from the 64-bit view, time-boxed', async () => {
    const source = system('win32', { [REG]: regOutput('    ') })
    expect(await readMachineId(source)).toEqual({ kind: 'id', id: GUID })
    // `/reg:64`: a 32-bit process under WOW64 reads the 64-bit view, where MachineGuid is.
    expect(source.runs).toEqual([
      {
        command: REG,
        args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        timeoutMs: MACHINE_ID_TIMEOUT_MS,
      },
    ])
    const fp = await nodeFingerprinter(system('win32', { [REG]: regOutput('    ') })).get()
    expect(fp).toBe(hashFingerprint(`machine-id|${GUID}`))
    expect(fp).not.toContain('3f2504e0')
  })

  it('runs the standard reg.exe, whatever %SystemRoot% says, and that one only when the standard is not there', async () => {
    const runs: string[] = []
    const at = (paths: Record<string, string | Error>, systemRoot: string): MachineIdSource => ({
      platform: 'win32',
      systemRoot,
      async run(command) {
        runs.push(command)
        const out = paths[command]
        if (out === undefined) throw failure({ code: 'ENOENT' })
        if (out instanceof Error) throw out
        return out
      },
      readFile: async () => '',
    })
    // An environment pointing elsewhere does not move it off the standard path.
    const elsewhere = 'D:\\Elsewhere\\System32\\reg.exe'
    expect(await readMachineId(at({ [REG]: regOutput('    '), [elsewhere]: regOutput('    ') }, 'D:\\Elsewhere'))).toEqual({
      kind: 'id',
      id: GUID,
    })
    expect(runs).toEqual([REG])
    // Windows installed elsewhere: the standard path is not there, %SystemRoot% is.
    runs.length = 0
    expect(await readMachineId(at({ [elsewhere]: regOutput('    ') }, 'D:\\Elsewhere'))).toEqual({ kind: 'id', id: GUID })
    expect(runs).toEqual([REG, elsewhere])
    // A standard reg.exe that ran and said no is the answer: no second try.
    runs.length = 0
    const said = { [REG]: 'ERROR: unable to find', [elsewhere]: regOutput('    ') }
    expect(await readMachineId(at(said, 'D:\\Elsewhere'))).toEqual({ kind: 'unavailable' })
    expect(runs).toEqual([REG])
    // Nor a standard reg.exe that exited non-zero, was killed, or failed oddly:
    // it is there, so it is the one that answers, whatever %SystemRoot% would.
    for (const [failed, kind] of [
      [failure({ code: 1 }), 'unavailable'],
      [failure({ killed: true, signal: 'SIGTERM' }), 'transient'],
      [failure({ code: 'EAGAIN' }), 'transient'],
    ] as const) {
      runs.length = 0
      expect(await readMachineId(at({ [REG]: failed, [elsewhere]: regOutput('    ') }, 'D:\\Elsewhere'))).toEqual({ kind })
      expect(runs).toEqual([REG])
    }
  })

  it.each([
    ['tabs', '\t'],
    ['single spaces', ' '],
  ])('reads the GUID out of reg output separated by %s, with no trailing \\r', async (_case, gap) => {
    expect(await readMachineId(system('win32', { [REG]: regOutput(gap) }))).toEqual({ kind: 'id', id: GUID })
  })

  it('reads the macOS IOPlatformUUID with /usr/sbin/ioreg', async () => {
    const source = system('darwin', { [IOREG]: MAC_OUTPUT })
    expect(await readMachineId(source)).toEqual({ kind: 'id', id: '564D8A1C-3F6E-4E3B-9F2A-1B2C3D4E5F60' })
    expect(source.runs.map((r) => [r.command, r.args])).toEqual([[IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice']]])
  })

  it('reads /etc/machine-id on Linux, else the D-Bus one, trimmed', async () => {
    const id = (files: Record<string, string | Error>) => readMachineId(system('linux', {}, files))
    expect(await id({ '/etc/machine-id': 'a1b2c3d4e5f6\n' })).toEqual({ kind: 'id', id: 'a1b2c3d4e5f6' })
    expect(await id({ '/var/lib/dbus/machine-id': 'dbus0001\n' })).toEqual({ kind: 'id', id: 'dbus0001' })
    // An empty systemd file, or one not ours to read, is not an id: the D-Bus one is read.
    expect(await id({ '/etc/machine-id': '\n', '/var/lib/dbus/machine-id': 'dbus0002' })).toEqual({ kind: 'id', id: 'dbus0002' })
    const denied = { '/etc/machine-id': failure({ code: 'EACCES' }), '/var/lib/dbus/machine-id': 'dbus0003' }
    expect(await id(denied)).toEqual({ kind: 'id', id: 'dbus0003' })
  })

  describe('a transient Linux machine id', () => {
    const ROOT = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw'
    const OVER_MACHINE_ID = '29 23 0:25 /machine-id /etc/machine-id ro,relatime shared:5 - tmpfs tmpfs rw'

    it('has no id to hold a device to when something is mounted at /etc/machine-id', async () => {
      const files = { '/proc/self/mountinfo': `${ROOT}\n${OVER_MACHINE_ID}\n`, '/etc/machine-id': 'transient-id\n' }
      expect(await readMachineId(system('linux', {}, files))).toEqual({ kind: 'unavailable' })
      // So the host name, a `hostname` fingerprint, never held to its device.
      const identity = await nodeFingerprinter(system('linux', {}, files)).identify?.({ timeoutMs: 1 })
      expect(identity).toMatchObject({ fingerprint: fallback, kind: 'hostname' })
    })

    it('reads the id when nothing is mounted at /etc/machine-id', async () => {
      const files = { '/proc/self/mountinfo': `${ROOT}\n`, '/etc/machine-id': 'a1b2c3d4e5f6\n' }
      expect(await readMachineId(system('linux', {}, files))).toEqual({ kind: 'id', id: 'a1b2c3d4e5f6' })
    })

    it.each([
      // The path as the mount's ROOT (field 4), mounted elsewhere.
      ["the path as a mount's root, not its mount point", '30 23 0:25 /etc/machine-id /run/host-id ro,relatime - tmpfs tmpfs rw'],
      // A mount point the path is only a prefix of.
      ['a mount point it is only a prefix of', '31 23 0:26 / /etc/machine-id.d rw,relatime - tmpfs tmpfs rw'],
    ])('reads the id when mountinfo has %s', async (_case, line) => {
      const files = { '/proc/self/mountinfo': `${ROOT}\n${line}\n`, '/etc/machine-id': 'a1b2c3d4e5f6\n' }
      expect(await readMachineId(system('linux', {}, files))).toEqual({ kind: 'id', id: 'a1b2c3d4e5f6' })
    })

    const ROOT_TMPFS = '1 0 0:1 / / rw,relatime shared:1 - tmpfs tmpfs rw'
    it.each([
      ['an impermanent root: / itself a tmpfs, no mount of its own', [ROOT_TMPFS], 'unavailable'],
      ['an impermanent /etc: a tmpfs', [ROOT, '2 1 0:2 / /etc rw,relatime shared:2 - tmpfs none rw'], 'unavailable'],
      ['a tmpfs /etc with no optional field', [ROOT, '2 1 0:2 / /etc rw - tmpfs none rw'], 'unavailable'],
      ['a tmpfs /etc with two optional fields', [ROOT, '2 1 0:2 / /etc rw shared:2 master:1 - tmpfs tmpfs rw'], 'unavailable'],
      [
        'an overmount listed BEFORE the mount it covers: the one no other names as its parent',
        ['5 29 8:1 /etc/machine-id /etc/machine-id ro - ext4 /dev/sda1 rw', ROOT, OVER_MACHINE_ID],
        'id',
      ],
      ['a mount point that is a prefix of the path but not a parent of it', [ROOT, '2 1 0:2 / /et rw - tmpfs tmpfs rw'], 'id'],
      ["systemd's transient id: a /run tmpfs file bound over it", [ROOT, OVER_MACHINE_ID], 'unavailable'],
      ['an escaped mount point (\\143 is c) that unescapes to /etc, a tmpfs', [ROOT, '2 1 0:2 / /et\\143 rw - tmpfs tmpfs rw'], 'unavailable'],
      ['a ramfs /etc', [ROOT, '2 1 0:2 / /etc rw master:4 - ramfs ramfs rw'], 'unavailable'],
      [
        "a stable id bound in from a disk (Flatpak's --ro-bind, a container volume)",
        [ROOT, '3 1 8:1 /etc/machine-id /etc/machine-id ro,relatime - ext4 /dev/sda1 rw'],
        'id',
      ],
      [
        'a persisted id bound over an impermanent root (impermanence)',
        [ROOT_TMPFS, '3 1 8:2 /persist/etc/machine-id /etc/machine-id rw - btrfs /dev/sda2 rw'],
        'id',
      ],
      [
        'a disk bind mounted over a tmpfs one at the same point: the last is the one seen',
        [ROOT, OVER_MACHINE_ID, '5 29 8:1 /etc/machine-id /etc/machine-id ro - ext4 /dev/sda1 rw'],
        'id',
      ],
      // Two at one point, neither naming the other as its parent: the parent
      // rule cannot settle it, so the last listed, both ways round.
      [
        'two mounts at one point, neither over the other, a tmpfs listed last',
        [ROOT, '3 1 8:1 /etc/machine-id /etc/machine-id ro - ext4 /dev/sda1 rw', '4 1 0:25 /machine-id /etc/machine-id ro - tmpfs tmpfs rw'],
        'unavailable',
      ],
      [
        'two mounts at one point, neither over the other, a disk listed last',
        [ROOT, '4 1 0:25 /machine-id /etc/machine-id ro - tmpfs tmpfs rw', '3 1 8:1 /etc/machine-id /etc/machine-id ro - ext4 /dev/sda1 rw'],
        'id',
      ],
    ] as const)('classifies by the filesystem holding the id: %s', async (_case, lines, kind) => {
      const files = { '/proc/self/mountinfo': `${lines.join('\n')}\n`, '/etc/machine-id': 'a1b2c3d4e5f6\n' }
      const expected = kind === 'id' ? { kind: 'id', id: 'a1b2c3d4e5f6' } : { kind }
      expect(await readMachineId(system('linux', {}, files))).toEqual(expected)
    })

    describe('an id written at this boot', () => {
      const BTIME = 1_757_000_000
      const BOOTED = BTIME * 1000
      /** A Linux machine with a persistent root, booted at BTIME, whose id file was written at `mtimeMs`. */
      function booted(written: { mtimeMs: number; ctimeMs?: number } | Error, procStat: string | Error = `cpu 1 2 3\nbtime ${BTIME}\n`) {
        const source = system('linux', {}, { '/proc/self/mountinfo': `${ROOT}\n`, '/etc/machine-id': 'a1b2c3d4e5f6\n', '/proc/stat': procStat })
        return {
          ...source,
          stat: async () => {
            if (written instanceof Error) throw written
            return { mtimeMs: written.mtimeMs, ctimeMs: written.ctimeMs ?? written.mtimeMs }
          },
        }
      }
      const id = { kind: 'id', id: 'a1b2c3d4e5f6' }

      it('is no id to hold a device to when the file is newer than the boot (a live USB, a btrfs rollback, a zram /etc)', async () => {
        expect(await readMachineId(booted({ mtimeMs: BOOTED + 3_000 }))).toEqual({ kind: 'unavailable' })
      })

      it('is the id when the file dates from before the boot, as on any installed system', async () => {
        expect(await readMachineId(booted({ mtimeMs: BOOTED - 90 * 86_400_000 }))).toEqual(id)
      })

      it('counts the slack before btime as this boot, and not a millisecond more', async () => {
        expect(await readMachineId(booted({ mtimeMs: BOOTED - BOOT_SLACK_MS }))).toEqual({ kind: 'unavailable' })
        expect(await readMachineId(booted({ mtimeMs: BOOTED - BOOT_SLACK_MS - 1 }))).toEqual(id)
      })

      it('judges by mtime alone: a ctime after the boot (a relabel, a chmod) with an old mtime is the id', async () => {
        // ctime moves with the inode, not the id: an SELinux relabel at boot
        // touches every file, and a stable id must stay an id through it.
        expect(await readMachineId(booted({ mtimeMs: BOOTED - 86_400_000, ctimeMs: BOOTED + 1_000 }))).toEqual(id)
      })

      it("reads the id as always when /proc/stat or the file's times cannot be read", async () => {
        expect(await readMachineId(booted({ mtimeMs: BOOTED + 3_000 }, failure({ code: 'ENOENT' })))).toEqual(id)
        expect(await readMachineId(booted({ mtimeMs: BOOTED + 3_000 }, 'cpu 1 2 3\n'))).toEqual(id)
        expect(await readMachineId(booted(failure({ code: 'EACCES' })))).toEqual(id)
      })
    })

    it('reads the id as always when mountinfo cannot be read', async () => {
      for (const unreadable of [undefined, failure({ code: 'EIO' }), failure({ code: 'EACCES' })]) {
        const files: Record<string, string | Error> = { '/etc/machine-id': 'a1b2c3d4e5f6\n' }
        if (unreadable) files['/proc/self/mountinfo'] = unreadable
        expect(await readMachineId(system('linux', {}, files))).toEqual({ kind: 'id', id: 'a1b2c3d4e5f6' })
      }
    })
  })

  it('survives a rename: the fingerprint follows the machine id, not the host name', async () => {
    const before = await nodeFingerprinter(system('linux', {}, { '/etc/machine-id': 'same-machine' })).get()
    const after = await nodeFingerprinter(system('linux', {}, { '/etc/machine-id': 'same-machine' })).get()
    expect(after).toBe(before)
    expect(before).not.toBe(fallback)
  })

  it('falls back to the host name, for good, when the machine has no id to read', async () => {
    for (const source of [
      system('win32'), // reg.exe not there
      system('win32', { [REG]: failure({ code: 1 }) }), // reg ran: no such value
      system('win32', { [REG]: 'ERROR: The system was unable to find the specified registry key or value.' }),
      system('darwin', { [IOREG]: 'no uuid here' }),
      system('linux'), // neither file
      system('linux', {}, { '/etc/machine-id': failure({ code: 'EACCES' }), '/var/lib/dbus/machine-id': failure({ code: 'EPERM' }) }),
      system('freebsd'),
    ]) {
      expect(await readMachineId(source)).toEqual({ kind: 'unavailable' })
      const fingerprinter = nodeFingerprinter(source)
      expect(await fingerprinter.get()).toBe(fallback)
      // Settled: kept, with no host-name alternate besides itself.
      expect(await fingerprinter.identify?.({ timeoutMs: 1 })).toEqual({ fingerprint: fallback, kind: 'hostname', alternates: [] })
    }
  })

  describe('what a failed read means', () => {
    const UNAVAILABLE = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR']
    const TRANSIENT: Array<[string, unknown]> = [
      ['EAGAIN', failure({ code: 'EAGAIN' })],
      ['EIO', failure({ code: 'EIO' })],
      ['EMFILE', failure({ code: 'EMFILE' })],
      ['killed, with an exit code', failure({ killed: true, code: 1 })],
      ['a rejection that is no Error', 'boom'],
    ]
    const rejecting = (platform: string, error: unknown): MachineIdSource => ({
      platform,
      systemRoot: 'C:\\Windows',
      run: () => Promise.reject(error),
      readFile: () => Promise.reject(error),
    })

    it.each(UNAVAILABLE)('reads %s as nothing to read, from a command and from the files', async (code) => {
      expect(await readMachineId(rejecting('win32', failure({ code })))).toEqual({ kind: 'unavailable' })
      expect(await readMachineId(rejecting('linux', failure({ code })))).toEqual({ kind: 'unavailable' })
    })

    it.each(TRANSIENT)('reads %s as a read that did not finish, from a command and from the files', async (_case, error) => {
      expect(await readMachineId(rejecting('darwin', error))).toEqual({ kind: 'transient' })
      expect(await readMachineId(rejecting('linux', error))).toEqual({ kind: 'transient' })
    })
  })

  it('gives NO fingerprint for a read that did not finish, and does not keep that', async () => {
    for (const source of [
      system('win32', { [REG]: failure({ killed: true, signal: 'SIGTERM' }) }), // killed at its time box
      system('win32', { [REG]: failure({ killed: true, code: 1 }) }), // killed, whatever exit code it reports
      system('darwin', { [IOREG]: failure({ code: 'EAGAIN' }) }), // an error nobody expected
      system('linux', {}, { '/etc/machine-id': failure({ code: 'EIO' }) }),
    ]) {
      expect(await readMachineId(source)).toEqual({ kind: 'transient' })
      const identity = await nodeFingerprinter(source).identify?.({ timeoutMs: MACHINE_ID_TIMEOUT_MS })
      // Not a stand-in: no fingerprint, and the host-name one only as what it may have been activated under.
      expect(identity).toEqual({ fingerprint: null, alternates: [fallback] })
    }
  })

  it('never throws: a reader that throws at once gives no fingerprint, and get() says it could not read', async () => {
    const throwing: MachineIdSource = {
      platform: 'win32',
      run: () => {
        throw new Error('spawn failed')
      },
      readFile: () => {
        throw new Error('no fs')
      },
    }
    expect(await readMachineId(throwing)).toEqual({ kind: 'transient' })
    expect(await readMachineId({ ...throwing, platform: 'linux' })).toEqual({ kind: 'transient' })
    await expect(nodeFingerprinter(throwing).identify?.({ timeoutMs: 1 })).resolves.toMatchObject({ fingerprint: null })
    await expect(nodeFingerprinter(throwing).get()).rejects.toThrow()
  })

  it('reads again after a read that did not finish, and keeps the id once it has it', async () => {
    let first = true
    const runs: Run[] = []
    const flaky: MachineIdSource = {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      async run(command, args, timeoutMs) {
        runs.push({ command, args, timeoutMs })
        if (first) {
          first = false
          throw failure({ killed: true, signal: 'SIGTERM' })
        }
        return regOutput('    ')
      },
      readFile: async () => '',
    }
    const fingerprinter = nodeFingerprinter(flaky)
    expect((await fingerprinter.identify?.({ timeoutMs: 1 }))?.fingerprint).toBeNull()
    const machine = hashFingerprint(`machine-id|${GUID}`)
    expect((await fingerprinter.identify?.({ timeoutMs: 1 }))?.fingerprint).toBe(machine)
    expect((await fingerprinter.identify?.({ timeoutMs: 1 }))?.fingerprint).toBe(machine)
    expect(runs).toHaveLength(2)
  })

  it('gives no fingerprint once the time box is out when the command never finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const hanging: MachineIdSource = {
        platform: 'darwin',
        run: () => new Promise<string>(() => {}),
        readFile: () => new Promise<string>(() => {}),
      }
      let reading: unknown
      const pending = readMachineId(hanging).then((r) => (reading = r))
      await vi.advanceTimersByTimeAsync(MACHINE_ID_TIMEOUT_MS)
      expect(reading).toBeUndefined()
      await vi.advanceTimersByTimeAsync(500)
      await pending
      expect(reading).toEqual({ kind: 'transient' })
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers the host-name fingerprint as an alternate beside the machine id's", async () => {
    const identity = await nodeFingerprinter(system('win32', { [REG]: regOutput('    ') })).identify?.({ timeoutMs: 1 })
    expect(identity).toEqual({ fingerprint: hashFingerprint(`machine-id|${GUID}`), kind: 'machine', alternates: [fallback] })
  })

  describe('the default fingerprinter, for the process', () => {
    afterEach(() => {
      vi.doUnmock('./machine-id.js')
      vi.resetModules()
    })

    /** adapters.js afresh, its `systemMachineIdSource` the given stand-in. */
    async function withSystem(source: MachineIdSource) {
      vi.resetModules()
      vi.doMock('./machine-id.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('./machine-id.js')>()),
        systemMachineIdSource: () => source,
      }))
      return import('./adapters.js')
    }

    it('returns a stable 64-char hex hash, kept for the process', async () => {
      const fresh = await withSystem(system('linux', {}, { '/etc/machine-id': 'a1b2c3d4e5f6\n' }))
      const a = await fresh.nodeFingerprinter().get()
      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(await fresh.nodeFingerprinter().get()).toBe(a)
    })

    it('reads the machine id once for the whole process', async () => {
      const source = system('win32', { [REG]: regOutput('    ') })
      const fresh = await withSystem(source)
      const a = await fresh.nodeFingerprinter().get()
      const b = await fresh.nodeFingerprinter().get()
      expect(b).toBe(a)
      expect(source.runs).toHaveLength(1)
    })

    it('does not keep a read that did not finish: the next fingerprinter reads again', async () => {
      const source = system('win32', { [REG]: failure({ killed: true, signal: 'SIGTERM' }) })
      const fresh = await withSystem(source)
      expect((await fresh.nodeFingerprinter().identify?.({ timeoutMs: 1 }))?.fingerprint).toBeNull()
      expect((await fresh.nodeFingerprinter().identify?.({ timeoutMs: 1 }))?.fingerprint).toBeNull()
      expect(source.runs).toHaveLength(2)
    })
  })
})

describe('noopRegistry', () => {
  it('reads null and accepts writes without throwing', async () => {
    const reg = noopRegistry()
    expect(await reg.readTrialStart()).toBeNull()
    await expect(reg.writeTrialStart(123)).resolves.toBeUndefined()
  })
})

describe('systemClock', () => {
  it('returns a numeric timestamp', () => {
    expect(typeof systemClock().now()).toBe('number')
  })
})

describe('fetchHttp', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns status and parsed json', async () => {
    globalThis.fetch = (async () => ({ status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch
    const res = await fetchHttp().post('https://x/y', { a: 1 })
    expect(res).toEqual({ status: 200, json: { ok: true } })
  })

  it('yields undefined json when the body is not JSON', async () => {
    globalThis.fetch = (async () => ({
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof fetch
    const res = await fetchHttp().post('https://x/y', {})
    expect(res).toEqual({ status: 500, json: undefined })
  })
})

describe('fetchHttp timeouts', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /** A fetch that never answers, and fails only when its signal aborts. */
  function hangingFetch(seen: { aborted: boolean }) {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          seen.aborted = true
          reject(new Error('aborted'))
        })
      })) as unknown as typeof fetch
  }

  it('bounds every call by default', () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('abandons a call given no bound at all at DEFAULT_HTTP_TIMEOUT_MS, and not before', async () => {
    vi.useFakeTimers()
    try {
      const seen = { aborted: false }
      hangingFetch(seen)
      // Its rejection is awaited below; attached now so it is never unhandled.
      const refused = expect(fetchHttp().post('https://x/y', {})).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS - 1)
      expect(seen.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await refused
      expect(seen.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("abandons a call that outlives the adapter's bound", async () => {
    const seen = { aborted: false }
    hangingFetch(seen)
    await expect(fetchHttp({ timeoutMs: 20 }).post('https://x/y', {})).rejects.toThrow()
    expect(seen.aborted).toBe(true)
  })

  it("takes a call's own bound over the adapter's", async () => {
    const seen = { aborted: false }
    hangingFetch(seen)
    const started = Date.now()
    await expect(fetchHttp({ timeoutMs: 60_000 }).post('https://x/y', {}, { timeoutMs: 20 })).rejects.toThrow()
    expect(seen.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
