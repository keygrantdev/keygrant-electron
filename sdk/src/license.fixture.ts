/**
 * The test harness `License` suites share: a License over in-memory storage, a
 * fixed clock, a scripted HTTP server (`FakeHttp`) and a stash, with the
 * product's signing key to sign leases with. Test support only: never
 * exported from the package, and left out of its declarations.
 */
import { generateKeyPair, importSigningKey, signLease, type LicenseModel } from '@keygrant/shared'
import { License } from './license.js'
import type { Adapters, Fingerprinter, HttpAdapter, StoredState } from './types.js'

export const NOW = 1_757_000_000_000
export const DAY = 86_400_000
export const PRODUCT = 'sluice'

export type Handler = (body: unknown) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>

export class FakeHttp implements HttpAdapter {
  handlers: Record<string, Handler> = {}
  calls: { action: string; body: unknown }[] = []
  fail = false
  /** Never answer: a network that takes the connection and says nothing. */
  hang = false
  on(action: string, handler: Handler): this {
    this.handlers[action] = handler
    return this
  }
  /** Those waiting for calls (`whenCalled`). */
  private waiting: { action: string; count: number; resolve: () => void }[] = []
  async post(url: string, body: unknown) {
    const action = url.split('/').pop() ?? ''
    this.calls.push({ action, body })
    this.waiting = this.waiting.filter((w) => (this.count(w.action) >= w.count ? (w.resolve(), false) : true))
    if (this.fail) throw new Error('network down')
    if (this.hang) return new Promise<never>(() => {})
    const handler = this.handlers[action]
    return handler ? handler(body) : { status: 404, json: { error: 'unknown' } }
  }
  called(action: string): boolean {
    return this.calls.some((c) => c.action === action)
  }
  /** How many `action` calls have been made. */
  count(action: string): number {
    return this.calls.filter((c) => c.action === action).length
  }
  /**
   * Resolves once `count` calls of `action` have been made (at once when they
   * have): a test waits for the SDK's request this way, however long the work
   * before it takes on a busy machine, rather than for some number of turns.
   */
  whenCalled(action: string, count = 1): Promise<void> {
    if (this.count(action) >= count) return Promise.resolve()
    return new Promise((resolve) => this.waiting.push({ action, count, resolve }))
  }
  /** The body of the first `action` call, failing the test when none was made. */
  bodyOf(action: string): unknown {
    const call = this.calls.find((c) => c.action === action)
    if (!call) throw new Error(`expected a ${action} call`)
    return call.body
  }
}

/**
 * Calls that never answer, counted, with a wait for the next (`when`): a test
 * lets a bound pass only once the SDK is stuck on one, rather than after some
 * number of turns of the event loop, which a busy machine may not be done in.
 */
export function stuckCalls() {
  let count = 0
  let waiting: { at: number; resolve: () => void }[] = []
  return {
    /** A call that never answers, counted. */
    hang<T>(): Promise<T> {
      count += 1
      waiting = waiting.filter((w) => (w.at <= count ? (w.resolve(), false) : true))
      return new Promise<T>(() => {})
    },
    /** How many calls have hung. */
    count: () => count,
    /** Resolves once `at` calls have hung. */
    when(at: number): Promise<void> {
      return count >= at ? Promise.resolve() : new Promise<void>((resolve) => waiting.push({ at, resolve }))
    },
  }
}

export type Stuck = ReturnType<typeof stuckCalls>

export async function harness(
  initial: StoredState | null = null,
  opts: { major?: number; deviceName?: string; httpTimeoutMs?: number; fingerprint?: Fingerprinter; deviceHold?: boolean } = {},
) {
  const { publicJwk, privateJwk } = await generateKeyPair()
  const signingKey = await importSigningKey(privateJwk)
  let stored: StoredState | null = initial
  let clockNow = NOW
  let registryStart: number | null = null
  /** Which of the stash's calls fail, as an app's own stash might. */
  let registryFails: { read?: boolean; write?: boolean } = {}
  let hangNextRead = false
  let holdNextWrite = false
  let releaseHeld: () => void = () => undefined
  let writes = 0
  let waitingWrites: { count: number; resolve: () => void }[] = []
  let failWrites = false
  let reads = 0
  /** The read, counted from the first, that fails (`failRead`). */
  let failReadAt: number | null = null
  const http = new FakeHttp()

  const adapters: Adapters = {
    storage: {
      async read() {
        reads += 1
        if (reads === failReadAt) throw Object.assign(new Error('EBUSY: held by a scan'), { code: 'EBUSY' })
        if (hangNextRead) {
          hangNextRead = false
          return new Promise<never>(() => {})
        }
        return stored
      },
      async write(s) {
        writes += 1
        waitingWrites = waitingWrites.filter((w) => (w.count <= writes ? (w.resolve(), false) : true))
        if (failWrites) throw Object.assign(new Error('EBUSY: the disk said no'), { code: 'EBUSY' })
        if (holdNextWrite) {
          // Held inside the adapter with the whole state it was handed, which
          // lands when released, whatever was written meanwhile.
          holdNextWrite = false
          return new Promise<void>((resolve) => {
            releaseHeld = () => {
              stored = { ...s }
              resolve()
            }
          })
        }
        stored = { ...s }
      },
    },
    registry: {
      async readTrialStart() {
        if (registryFails.read) throw new Error('the registry said no')
        return registryStart
      },
      async writeTrialStart(ms) {
        if (registryFails.write) throw new Error('the registry said no')
        registryStart = ms
      },
    },
    clock: { now: () => clockNow },
    fingerprint: opts.fingerprint ?? { async get() { return 'fp-test' } },
    http,
  }

  const license = new License({
    product: PRODUCT,
    apiBaseUrl: 'https://api.test/',
    publicJwk,
    major: opts.major,
    deviceName: opts.deviceName,
    ...(opts.httpTimeoutMs !== undefined ? { httpTimeoutMs: opts.httpTimeoutMs } : {}),
    ...(opts.deviceHold !== undefined ? { deviceHold: opts.deviceHold } : {}),
    adapters,
  })

  async function sign(sub: string, model: LicenseModel, ttlSeconds: number, now = NOW): Promise<string> {
    return signLease({ sub, product: PRODUCT, aid: 'act_1', model, lim: 3, major: 1, ent: {}, ttlSeconds }, signingKey, now)
  }

  return {
    license,
    publicJwk,
    adapters,
    /** Another build of the app on this device: the same storage and server, another major. */
    licenseFor: (major: number) =>
      new License({ product: PRODUCT, apiBaseUrl: 'https://api.test/', publicJwk, major, adapters }),
    http,
    sign,
    signingKey,
    getStored: () => stored,
    setStored: (s: StoredState | null) => {
      stored = s
    },
    setClock: (n: number) => {
      clockNow = n
    },
    setRegistry: (n: number | null) => {
      registryStart = n
    },
    /** The next storage read never settles: an adapter stuck on a dead disk. */
    hangNextRead: () => {
      hangNextRead = true
    },
    /** The next storage write is held inside the adapter; returns what lets it land. */
    holdNextWrite: () => {
      holdNextWrite = true
      return () => releaseHeld()
    },
    writes: () => writes,
    /** Resolves once `count` writes have begun (a held one included), at once when they have. */
    whenWritten: (count = 1) =>
      writes >= count ? Promise.resolve() : new Promise<void>((resolve) => waitingWrites.push({ count, resolve })),
    /** The `nth` read from now fails, as a file an antivirus scan holds does. */
    failRead: (nth: number) => {
      failReadAt = reads + nth
    },
    /** Every storage write fails from now on (`false` to stop): a file held by an antivirus scan. */
    failWrites: (on = true) => {
      failWrites = on
    },
    getRegistry: () => registryStart,
    failRegistry: (fails: { read?: boolean; write?: boolean }) => {
      registryFails = fails
    },
  }
}

/** What `harness` gives a test. */
export type Harness = Awaited<ReturnType<typeof harness>>
