/**
 * The world a property test of `use()` runs the real `License` in (use.property.test.ts): two processes of the
 * app over one state file and one device clock, a KeyGrant server (property-server.fixture.ts) whose every
 * answer a step may lose, delay or refuse, a disk that may refuse its writes, and a device clock that jumps
 * forward and back. A case is plain data (`Case`), so a failing one is shrunk and kept as a named test.
 *
 * The oracle is written from the contract (section 12) and takes nothing from the code it judges but the `License`
 * itself and the shape of a stored state: its constants, its figures and its waits are written again below, so a
 * change to the code cannot move the code and what judges it together.
 * Test support only: never exported from the package, and left out of its declarations.
 */
import { vi } from 'vitest'
import { generateKeyPair, importSigningKey } from '@keygrant/shared'
import { License } from './license.js'
import { NOW, PRODUCT } from './license.fixture.js'
import { KEY } from './meters.fixture.js'
import { Server, type MeterSpec, type Served } from './property-server.fixture.js'
import type { JournalOp } from './journal.js'
import type { SpendEntry } from './meter-types.js'
import type { HttpAdapter, LicenseStatus, StoredState, UseResult } from './types.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The contract's numbers (12.4, 12.5): the journal's entries and voids. */
const ENTRIES = 64
const VOIDS = 16

export type Net = 'good' | 'down' | 'flaky'

/** One `use()` of a process. */
export interface Call {
  p: number
  meter: string
  n: number
}

/** An entry the journal already holds when the case begins. `recorded`: the server holds the spend (or the report) already. */
export interface Preloaded {
  meter: string
  n: number
  kind: 'offline' | 'unanswered' | 'void'
  agoMs: number
  recorded: boolean
}

/** What a step does; `r` are the random numbers its requests draw their fates from, so a case replays whole. */
export type Step =
  | { t: 'use'; calls: Call[]; status?: { p: number; force: boolean }; r: number[] }
  | { t: 'status'; p: number; force: boolean; r: number[] }
  | { t: 'repeat'; call: Call; times: number; gapMs: number; r: number[] }
  | { t: 'deactivate'; p: number; r: number[] }
  | { t: 'restart'; p: number }
  | { t: 'wait'; ms: number }
  | { t: 'jump'; ms: number }
  | { t: 'net'; mode: Net }
  | { t: 'disk'; failing: boolean }

export interface Case {
  seed: number
  meters: Record<string, MeterSpec>
  preload: Preloaded[]
  steps: Step[]
}

/** A property that did not hold: which, and where. */
export class Failure extends Error {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(`${invariant}: ${message}`)
  }
}

/** A request a process made for one of its `use()` calls. */
interface Req {
  meter: string
  n: number
  id: string
  /** The server recorded the spend. */
  applied: boolean
  /** The SDK got a usable answer. */
  answered: boolean
}

/** A process of the app: the real `License`, with what the property test reads of it. */
class Proc extends License {
  useReqs: Req[] = []
  /** The state as this process sees it: the stored one with what it could not save landed. */
  view(): Promise<StoredState> {
    return this.load(true)
  }
  /** What this process holds in memory because a save failed. */
  held(): readonly JournalOp[] {
    return this.unsaved
  }
}

// --- the oracle's own reading of the contract -----------------------------------------------

const entriesOf = (state: StoredState): SpendEntry[] => state.spends ?? []

/** 12.4: the unsynced spends of a meter, its `offline` and `unanswered` entries, never a void. */
const unsyncedIn = (spends: readonly SpendEntry[], meter: string): number => spends.reduce((sum, e) => (e.meter === meter && e.kind !== 'void' ? sum + e.n : sum), 0)

interface Figure {
  left: number
  total: number
  offline: number
}

/** 12.4: a meter's base figure: the stored one when its time is at or after the lease's second, else the lease's own. */
function baseFigure(state: StoredState, meter: string): Figure | undefined {
  if (state.key === undefined || state.lease === undefined) return undefined
  const claims = JSON.parse(Buffer.from(state.lease.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat: number; met?: Record<string, Figure> }
  const stored = (state.meterFigures as Record<string, Figure & { at: number }> | undefined)?.[meter]
  return stored !== undefined && stored.at >= claims.iat * 1000 ? stored : claims.met?.[meter]
}

/** 12.5: the journal's wait: k unanswered or void entries (none ahead of `now`), a minute doubling to an hour after the newest. */
function journalWait(spends: readonly SpendEntry[], now: number): boolean {
  const opened = spends.filter((e) => e.kind !== 'offline' && e.at <= now)
  if (opened.length === 0) return false
  const newest = Math.max(...opened.map((e) => e.at))
  return now < newest + Math.min(HOUR, MINUTE * 2 ** Math.min(opened.length - 1, 6))
}

/** 12.5: the wait of a spend the allowance refuses: a void under a minute old, by the guarded clock and the device clock. */
const voidWait = (spends: readonly SpendEntry[], now: number, clockNow: number): boolean => spends.some((e) => e.kind === 'void' && e.at <= now && e.at <= clockNow && now < e.at + MINUTE)

/** 12.5: the wait an unanswered ask leaves, by the device clock. */
const askWait = (state: StoredState, clockNow: number): boolean =>
  state.backoffSince !== undefined && state.backoffMs === MINUTE && clockNow >= state.backoffSince && clockNow < state.backoffSince + MINUTE

/** What the state said of a spend before the call. */
interface Pre {
  licensed: boolean
  covered: boolean
  /** What `use()` must answer as `left` for a spend made offline: the figure less the unsynced, less the spend. */
  leftAfter: number
  entries: number
  openOffline: boolean
  /** A wait of the covered spends runs: the no-answer wait (device clock) or the journal's (guarded clock). */
  waiting: boolean
  /** The wait of a spend the allowance refuses runs. */
  voidWaiting: boolean
}

type Fate = 'ok' | 'lost' | 'lost-after' | 'hang' | 'hang-after' | 'fail' | 'fail-after' | 'limited'

function fateOf(net: Net, r: number): Fate {
  if (net === 'good') return 'ok'
  const thresholds: [number, Fate][] =
    net === 'down'
      ? [[0.45, 'lost'], [0.75, 'lost-after'], [0.88, 'hang']]
      : [[0.35, 'ok'], [0.45, 'lost'], [0.55, 'lost-after'], [0.65, 'fail'], [0.75, 'fail-after'], [0.82, 'limited'], [0.9, 'hang']]
  return thresholds.find(([below]) => r < below)?.[1] ?? 'hang-after'
}

// --- crypto: counted, run one at a time, and remembered --------------------------------------

/** WebCrypto operations under way: their end is a turn of the event loop the fake clock must wait for. */
let cryptoUnderway = 0
let instrumented = false
/** What the three pure operations came to, by what they were asked: an Ed25519 signature and a digest are functions of their input. */
const memo = new Map<string, unknown>()

/**
 * Count the WebCrypto operations under way, run those that are not remembered one at a time in the order they were
 * asked (so which of two processes goes on first never depends on which job the thread pool finished first), and
 * remember what signing, verifying and digesting came to (all pure), so a thousand sequences do not spend their
 * time on the thread pool. The answers are the real ones, the first time.
 */
function instrumentCrypto(): void {
  memo.clear()
  if (instrumented) return
  instrumented = true
  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const ids = new WeakMap<object, number>()
  let issued = 0
  let queue: Promise<unknown> = Promise.resolve()
  const idOf = (key: unknown): number => {
    const k = key as object
    if (!ids.has(k)) ids.set(k, (issued += 1))
    return ids.get(k) as number
  }
  const bytes = (v: unknown): string => {
    const view = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength)
    return Buffer.from(view).toString('latin1')
  }
  const questions: Record<string, (args: unknown[]) => string> = {
    sign: (a) => `sign ${idOf(a[1])} ${bytes(a[2])}`,
    verify: (a) => `verify ${idOf(a[1])} ${bytes(a[2])} ${bytes(a[3])}`,
    digest: (a) => `digest ${typeof a[0] === 'string' ? a[0] : (a[0] as { name: string }).name} ${bytes(a[1])}`,
  }
  for (const name of ['sign', 'verify', 'digest', 'importKey', 'exportKey', 'generateKey']) {
    const original = subtle[name] as (...args: unknown[]) => Promise<unknown>
    const question = questions[name]
    subtle[name] = (...args: unknown[]) => {
      const asked = question?.(args)
      if (asked !== undefined && memo.has(asked)) {
        const known = memo.get(asked)
        return Promise.resolve(known instanceof ArrayBuffer ? known.slice(0) : known)
      }
      cryptoUnderway += 1
      const running = queue.then(() => original.apply(crypto.subtle, args))
      queue = running.then(() => undefined, () => undefined)
      const done = () => void (cryptoUnderway -= 1)
      running.then(done, done)
      return asked === undefined ? running : running.then((answer) => (memo.set(asked, answer instanceof ArrayBuffer ? answer.slice(0) : answer), answer))
    }
  }
}

let keys: Promise<{ publicJwk: JsonWebKey; signingKey: CryptoKey }> | undefined
function testKeys() {
  keys ??= generateKeyPair().then(async ({ publicJwk, privateJwk }) => ({ publicJwk, signingKey: await importSigningKey(privateJwk) }))
  return keys
}

/** A state as a file gives it back, as the shared harness's storage does (license.fixture.ts): the SDK builds new states and never changes one it was given. */
const copy = (s: StoredState): StoredState => ({ ...s })

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

export class World {
  private readonly server: Server
  private procs: Proc[]
  private state: StoredState
  private trueNow = NOW
  private offset = 0
  private net: Net = 'good'
  private diskFailing = false
  private rs: number[] = [0.5]
  private rk = 0
  private stepNo = -1
  /** What happened, for reading a failing case (`runCase`'s `trace`). */
  readonly trace: string[] = []
  /** Whether the trace is written (a case being read, not run). */
  tracing = false
  private readonly labels = new Map<string, string>()
  /** The ids of the entries the case begins with. */
  private readonly preIds = new Set<string>()
  /** Every use() the customer was told was made, by meter. */
  private readonly acked: Record<string, number> = {}
  /** What the customer was told was made while only memory held it and has not been reported since, by meter: the overage the allowance may show. */
  private readonly told: Record<string, number> = {}
  private toldOps = 0
  /** What the contract allows to be lost unreported, by meter: with a release that got no 200, beyond its 64 entries, in another process's memory, or in a process that ended. */
  private readonly lossAllowed: Record<string, number> = {}
  /**
   * Spends the customer was refused after the server recorded them: the take-back is the void's. `full`: the journal
   * was full when the spend was made, so the void may have found no room.
   */
  private readonly phantoms: { id: string; meter: string; n: number; full: boolean }[] = []
  /** The voids the contract let be lost before the server heard them, each by its id: replaced by a newer one, dropped with a release, held by a process that ended. */
  private readonly lostVoids = new Set<string>()
  /** The ids of the voids each process held in memory at the last check: one that leaves memory without landing is accounted for. */
  private readonly heldVoids: Set<string>[] = [new Set(), new Set()]
  /** The voids held in memory when a save left the journal at its size: one that did not land may have found no room. */
  private readonly refusedVoids = new Set<string>()
  /** A save that dropped a void with nothing to replace it, found inside the SDK's save (where a throw would be swallowed) and thrown by the next check. */
  private violation: string | undefined
  /** The releases a step made: whether the server recorded each, and the entries it carried. */
  private releases: { applied: boolean; ids: Set<string> }[] = []

  private constructor(
    private readonly c: Case,
    private readonly publicJwk: JsonWebKey,
    signingKey: CryptoKey,
  ) {
    this.server = new Server(c.meters, signingKey, NOW)
    this.state = {}
    for (const m of Object.keys(c.meters)) {
      this.acked[m] = 0
      this.told[m] = 0
      this.lossAllowed[m] = 0
    }
    const preId = (i: number) => `pre${String(i).padStart(3, '0')}`.padEnd(22, 'p')
    const spends: SpendEntry[] = c.preload.map((e, i) => ({ id: preId(i), meter: e.meter, n: e.n, at: NOW - e.agoMs, kind: e.kind }))
    c.preload.forEach((e, i) => {
      this.preIds.add(preId(i))
      if (e.recorded) this.server.recorded.set(preId(i), { meter: e.meter, n: e.n })
      if (e.kind === 'void') this.phantoms.push({ id: preId(i), meter: e.meter, n: e.n, full: false })
      else this.credit(this.acked, e.meter, e.n)
    })
    this.state = { key: KEY, activationId: 'act_1', lastSeen: NOW, ...(spends.length > 0 ? { spends } : {}) }
    // A journal that begins past the cap is one that spends told to the customer once landed past it.
    this.toldOps = Math.max(0, spends.length - ENTRIES)
    for (const e of spends) if (e.kind !== 'void') this.credit(this.told, e.meter, e.n)
    this.procs = [0, 1].map((i) => this.process(i, this.publicJwk))
  }

  static async create(c: Case): Promise<World> {
    instrumentCrypto()
    const { publicJwk, signingKey } = await testKeys()
    const world = new World(c, publicJwk, signingKey)
    world.state = { ...world.state, lease: await world.server.lease('act_1') }
    return world
  }

  private credit(into: Record<string, number>, meter: string, n: number) {
    if (meter in into) into[meter] = (into[meter] ?? 0) + n
  }

  /** An id as the trace shows it: the order it was first seen in, so a case reads the same every time. */
  private label(id: string | undefined): string {
    if (id === undefined) return ''
    if (!this.labels.has(id)) this.labels.set(id, this.preIds.has(id) ? id.slice(0, 6) : `s${this.labels.size}`)
    return this.labels.get(id) as string
  }

  // --- the machine ------------------------------------------------------------------

  private process(index: number, publicJwk: JsonWebKey): Proc {
    const busy = () => Object.assign(new Error('EBUSY: the disk said no'), { code: 'EBUSY' })
    const storage = {
      read: async () => copy(this.state),
      write: async (s: StoredState) => {
        if (this.diskFailing) throw busy()
        this.landed(this.state, s)
        this.state = copy(s)
      },
      update: async (merge: (latest: StoredState) => StoredState) => {
        await Promise.resolve()
        const next = merge(copy(this.state))
        if (this.diskFailing) throw busy()
        this.landed(this.state, next)
        this.state = copy(next)
      },
    }
    const http: HttpAdapter = {
      post: async (url, body) => {
        const action = url.split('/').pop() ?? ''
        const r = this.rs[this.rk % this.rs.length] ?? 0.5
        this.rk += 1
        for (let ticks = Math.floor(((r * 1e4) % 1) * 4); ticks > 0; ticks -= 1) await Promise.resolve()
        return this.deliver(index, action, body as Parameters<Server['handle']>[1], fateOf(this.net, r))
      },
    }
    return new Proc({
      product: PRODUCT,
      apiBaseUrl: 'https://api.test/',
      publicJwk,
      adapters: {
        storage,
        registry: { readTrialStart: async () => null, writeTrialStart: async () => undefined },
        clock: { now: () => this.trueNow + this.offset },
        fingerprint: { get: async () => 'fp-test' },
        http,
      },
    })
  }

  /**
   * A save that landed. A void that left the journal and that the server did not confirm was replaced (12.4), and a
   * replacement happens only when a void lands with sixteen standing: for each void that lands (one now in the journal
   * that was not, or one held that is in neither, whether refused or confirmed in the same save) the oldest may go. A
   * void dropped otherwise is a fault, kept for the next check to throw. A seat taken or dropped is the release's and the
   * restart's to account for.
   */
  private landed(before: StoredState, after: StoredState): void {
    if (before.activationId !== after.activationId || after.key === undefined) return
    const was = entriesOf(before)
    const now = entriesOf(after)
    const kept = new Set(now.map((e) => e.id))
    const had = new Set(was.map((e) => e.id))
    const dropped = was.filter((e) => e.kind === 'void' && !kept.has(e.id) && !this.server.voided.has(e.id))
    const landing = new Set([
      ...now.filter((e) => e.kind === 'void' && !had.has(e.id)).map((e) => e.id),
      ...this.procs.flatMap((p) => p.held().flatMap((op) => (op.kind === 'void' && !had.has(op.id) && !kept.has(op.id) ? [op.id] : []))),
    ]).size
    const standing = was.filter((e) => e.kind === 'void').length
    if (dropped.length > 0) {
      if (dropped.length <= landing && standing + landing > VOIDS) for (const e of dropped) this.lostVoids.add(e.id)
      else this.violation ??= `${dropped.length} void(s) left the journal of ${standing} voids with ${landing} landing, and nothing was to replace them`
    }
    // Left at its size, with sixteen voids' oldest not yet replaced, the journal took no more: a void that was held and did not land found no room.
    if (now.length - (now.filter((e) => e.kind === 'void').length >= VOIDS ? 1 : 0) >= ENTRIES) {
      for (const p of this.procs) for (const op of p.held()) if (op.kind === 'void' && !kept.has(op.id)) this.refusedVoids.add(op.id)
    }
  }

  /** What a request comes to over a network that may lose it, or its answer, or both. */
  private async deliver(index: number, action: string, body: Parameters<Server['handle']>[1], fate: Fate): Promise<{ status: number; json: unknown }> {
    const served = async (answered: boolean): Promise<Served> => {
      const s = await this.server.handle(action, body)
      this.noted(index, action, body, s, answered)
      return s
    }
    switch (fate) {
      case 'ok': {
        const s = await served(true)
        return { status: s.status, json: s.json }
      }
      case 'lost-after':
        await served(false)
        throw new Error('network down')
      case 'hang-after':
        await served(false)
        return new Promise<never>(() => undefined)
      case 'fail-after': {
        const s = await served(false)
        return { status: 500, json: s.json }
      }
      case 'lost':
        this.noted(index, action, body, undefined, false)
        throw new Error('network down')
      case 'hang':
        this.noted(index, action, body, undefined, false)
        return new Promise<never>(() => undefined)
      case 'fail':
        this.noted(index, action, body, undefined, false)
        return { status: 503, json: { error: 'unavailable' } }
      case 'limited':
        this.noted(index, action, body, undefined, false)
        return { status: 429, json: { error: 'rate-limited' } }
    }
  }

  private noted(index: number, action: string, body: Parameters<Server['handle']>[1], served: Served | undefined, answered: boolean) {
    if (this.tracing) {
      const reports = body.spends?.map((e) => `${this.label(e.id)}:${e.meter}:${e.n}${e.void ? 'v' : ''}`)
      this.trace.push(`  p${index} ${action} ${JSON.stringify({ meter: body.meter, n: body.n, id: this.label(body.id), spends: reports })} -> ${served ? served.status : 'lost'} ${answered ? 'answered' : 'unanswered'}`)
    }
    if (action === 'deactivate') this.releases.push({ applied: served !== undefined, ids: new Set((body.spends ?? []).map((e) => e.id)) })
    if (action !== 'use') return
    this.procs[index]?.useReqs.push({ meter: body.meter ?? '', n: body.n ?? 0, id: body.id ?? '', applied: served?.spent !== undefined, answered })
  }

  /**
   * Settle calls that may hang on the network. The SDK's timeouts run on a fake clock, which moves on only when
   * nothing else can: every promise has run (one turn of the event loop) and no crypto is under way. Whatever is
   * still waiting then is waiting for a timeout, so a case replays the same way on a slow machine.
   */
  private async settle(calls: Promise<unknown>[]): Promise<({ ok: true; v: unknown } | { ok: false; e: unknown })[]> {
    const wrapped = calls.map((p) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })))
    let done = false
    const all = Promise.all(wrapped).then((r) => {
      done = true
      return r
    })
    const began = performance.now()
    for (let advanced = 0; ; ) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (done) return all
      if (performance.now() - began > 30_000 || advanced > 200 || (cryptoUnderway === 0 && vi.getTimerCount() === 0)) {
        throw new Failure('stuck', `a call never settled (step ${this.stepNo}, ${vi.getTimerCount()} timers pending, ${cryptoUnderway} crypto under way)`)
      }
      if (cryptoUnderway === 0) {
        await vi.advanceTimersToNextTimerAsync()
        advanced += 1
      }
    }
  }

  private fail(invariant: string, message: string): never {
    throw new Failure(invariant, `${message} (step ${this.stepNo}: ${JSON.stringify(this.c.steps[this.stepNo])})`)
  }

  // --- the steps --------------------------------------------------------------------

  async run(): Promise<void> {
    for (const [i, step] of this.c.steps.entries()) {
      this.stepNo = i
      if (this.tracing) this.trace.push(`step ${i}: ${JSON.stringify({ ...step, r: undefined })} net=${this.net} disk=${this.diskFailing ? 'failing' : 'ok'} clock=${this.trueNow + this.offset - NOW}`)
      await this.step(step)
      if (this.tracing) this.describe()
      await this.check()
    }
    this.stepNo = this.c.steps.length
    await this.converge()
  }

  private async step(s: Step): Promise<void> {
    if ('r' in s) {
      this.rs = s.r.length > 0 ? s.r : [0.5]
      this.rk = 0
    }
    switch (s.t) {
      case 'wait':
        this.pass(s.ms)
        return
      case 'repeat':
        for (let i = 0; i < s.times; i += 1) {
          this.pass(s.gapMs)
          await this.ensureActive()
          await this.use({ t: 'use', calls: [s.call], r: s.r })
          await this.check()
        }
        return
      case 'jump':
        this.offset = Math.max(-3 * DAY, Math.min(3 * DAY, this.offset + s.ms))
        return
      case 'net':
        this.net = s.mode
        return
      case 'disk':
        this.diskFailing = s.failing
        return
      case 'status': {
        await this.ensureActive()
        const out = await this.settle([this.procs[s.p]?.status(s.force) ?? Promise.resolve(null)])
        if (!out[0]?.ok) this.fail('status-rejected', String((out[0] as { e: unknown }).e))
        return
      }
      case 'deactivate':
        await this.ensureActive()
        return this.deactivate(s.p)
      case 'restart':
        return this.restart(s.p)
      case 'use':
        await this.ensureActive()
        return this.use(s)
    }
  }

  /** Time passes, for the server and the device alike. */
  private pass(ms: number): void {
    this.trueNow += ms
    this.server.now = Math.max(this.server.now, this.trueNow)
  }

  /**
   * A release drops the journal of the seat. The releasing process lands what it holds first, so the release carries
   * its journal: the contract lets it drop an entry only when the server got none of it (no 200) or it is past the 64
   * a report holds; a void it was meant to carry and did not, in any other case, is a fault. What another process held
   * only in memory is lost with the seat.
   */
  private async deactivate(p: number): Promise<void> {
    const proc = this.procs[p] as Proc
    const journal = entriesOf(await proc.view())
    const others = this.procs.flatMap((q, i) => (i === p ? [] : [...q.held()]))
    this.releases = []
    const out = await this.settle([proc.deactivate()])
    if (!out[0]?.ok) {
      // It rejects, the key kept, when the state cannot be saved; any other reason is a bug.
      if (!this.diskFailing) this.fail('deactivate-rejected', String((out[0] as { e: unknown }).e))
      return
    }
    const carried = new Set(this.releases.filter((r) => r.applied).flatMap((r) => [...r.ids]))
    const applied = this.releases.some((r) => r.applied)
    for (const [index, e] of journal.entries()) {
      // The report holds the first 64 of the journal in the order the SDK keeps it: only what the server got none of (no 200) or what is past them may be dropped.
      const mayDrop = !applied || index >= ENTRIES
      if (e.kind === 'void') {
        if (carried.has(e.id) || this.server.voided.has(e.id)) continue
        if (!mayDrop) this.fail('release-dropped-void', `a release left a void of the journal behind: ${this.label(e.id)} is entry ${index} of ${journal.length} (${carried.size} carried)`)
        this.lostVoids.add(e.id)
      } else if (mayDrop) {
        // What the server holds of it already is not lost; the rest is, and the contract allows it.
        this.credit(this.lossAllowed, e.meter, Math.max(0, e.n - (this.server.recorded.get(e.id)?.n ?? 0)))
      }
    }
    for (const op of others) {
      if (op.kind === 'offline' || op.kind === 'unanswered') this.credit(this.lossAllowed, op.meter, op.n)
      else if (op.kind === 'void') this.lostVoids.add(op.id)
    }
  }

  /** The app ends and starts again: what its process held only in memory is gone, and the customer was told it was made. */
  private async restart(p: number): Promise<void> {
    const old = this.procs[p] as Proc
    for (const op of old.held()) {
      if (op.kind === 'offline' || op.kind === 'unanswered') this.credit(this.lossAllowed, op.meter, op.n)
      else if (op.kind === 'void') this.lostVoids.add(op.id)
    }
    this.heldVoids[p] = new Set()
    this.procs[p] = this.process(p, this.publicJwk)
  }

  /** The seat is taken (on a good network and disk) when a release dropped it: the app activates again. */
  private async ensureActive(): Promise<void> {
    if (this.state.key !== undefined) return
    const [net, disk] = [this.net, this.diskFailing]
    this.net = 'good'
    this.diskFailing = false
    const out = await this.settle([this.procs[0]?.activate(KEY) ?? Promise.resolve(null)])
    if (!out[0]?.ok || (out[0].v as { ok?: boolean }).ok !== true) this.fail('reactivation', JSON.stringify(out[0]))
    ;[this.net, this.diskFailing] = [net, disk]
  }

  private async preOf(c: Call): Promise<Pre> {
    const state = await (this.procs[c.p] as Proc).view()
    const spends = entriesOf(state)
    const figure = baseFigure(state, c.meter)
    const unsynced = unsyncedIn(spends, c.meter)
    const clockNow = this.trueNow + this.offset
    const guarded = Math.max(clockNow, state.lastSeen ?? 0)
    const left = figure === undefined ? 0 : Math.max(0, figure.left - unsynced)
    return {
      licensed: state.key !== undefined && state.lease !== undefined,
      covered: figure !== undefined && unsynced + c.n <= figure.offline && c.n <= left,
      leftAfter: left - c.n,
      entries: spends.length,
      openOffline: spends.some((e) => e.kind === 'offline' && e.meter === c.meter),
      waiting: askWait(state, clockNow) || journalWait(spends, guarded),
      voidWaiting: voidWait(spends, guarded, clockNow),
    }
  }

  private async use(s: Extract<Step, { t: 'use' }>): Promise<void> {
    const concurrent = s.calls.length > 1 || s.status !== undefined
    // Behind a call that has not finished a process saves nothing: what it spends offline is kept in memory, and told.
    const behind = s.calls.some((c, i) => s.calls.some((d, j) => i < j && c.p === d.p)) || (s.status !== undefined && s.calls.some((c) => c.p === s.status?.p))
    const risky = this.diskFailing || behind
    const pres: Pre[] = []
    for (const c of s.calls) pres.push(await this.preOf(c))
    for (const p of this.procs) p.useReqs = []
    const calls = s.calls.map((c) => (this.procs[c.p] as Proc).use(c.meter, c.n))
    const side = s.status ? [(this.procs[s.status.p] as Proc).status(s.status.force)] : []
    const out = await this.settle([...calls, ...side])
    // What each process sees now: a spend after the first of two may meet a journal the first filled.
    const views = await Promise.all(this.procs.map(async (p) => entriesOf(await p.view())))
    for (const [i, c] of s.calls.entries()) {
      const o = out[i]
      if (!o?.ok) return this.fail('use-rejected', String((o as { e: unknown } | undefined)?.e))
      const reqs = (this.procs[c.p] as Proc).useReqs.filter((q) => q.meter === c.meter)
      if (this.tracing) this.trace.push(`  p${c.p} use ${c.meter} ${c.n} => ${JSON.stringify(o.v)}`)
      this.judge(c, pres[i] as Pre, o.v as UseResult, reqs, concurrent, risky, views[c.p] ?? [])
    }
    for (const o of out.slice(s.calls.length)) if (!o.ok) this.fail('status-rejected', String(o.e))
  }

  /** What the contract says of an answer, and the ledger of what the customer was told. */
  private judge(c: Call, pre: Pre, res: UseResult, reqs: Req[], concurrent: boolean, risky: boolean, view: SpendEntry[]): void {
    const asked = reqs.length > 0
    const alone = !concurrent && pre.licensed
    if (alone && !pre.covered && pre.voidWaiting && asked) this.fail('uncovered-asked-in-wait', `${c.n} of ${c.meter} asked the server while a void under a minute old stands`)
    if (alone && pre.covered && asked === pre.waiting) this.fail('covered-ask-rule', `${c.n} of ${c.meter} ${asked ? 'asked the server while a wait runs' : 'did not ask the server though no wait runs'}`)
    if (res.ok) {
      // 12.4: what is left is never told high. Made offline it is the figure less the unsynced, less the spend; online the server's own is at most what it has.
      if (alone && res.offline === true && res.left !== pre.leftAfter) this.fail('left-wrong', `${c.n} of ${c.meter} made offline answered ${res.left} left, the figure and the unsynced say ${pre.leftAfter}`)
      if (alone && res.offline !== true && res.left > this.server.left(c.meter)) this.fail('left-high', `${c.n} of ${c.meter} answered ${res.left} left, the server has ${this.server.left(c.meter)}`)
      this.credit(this.acked, c.meter, c.n)
      if (res.offline === true && risky) {
        this.credit(this.told, c.meter, c.n)
        this.toldOps += 1
      }
      return
    }
    // A void finds no room when the journal, less the oldest void if sixteen stand and the new one takes its place, still holds the cap; one that landed, or is held, found its room.
    const crowded = Math.max(pre.entries, view.length) - (view.filter((e) => e.kind === 'void').length >= VOIDS ? 1 : 0) >= ENTRIES
    const placed = (id: string) => view.some((e) => e.id === id) || this.procs.some((p) => p.held().some((op) => op.kind === 'void' && op.id === id))
    for (const q of reqs) if (q.applied && !q.answered) this.phantoms.push({ id: q.id, meter: q.meter, n: q.n, full: crowded && !placed(q.id) })
    if (concurrent || !pre.licensed || (res.error !== 'offline-limit' && res.error !== 'no-meter')) return
    if (pre.covered && res.error === 'offline-limit') {
      // A covered spend is refused only for the journal's size: it would open a 65th entry.
      const capped = pre.entries >= ENTRIES && (asked || !pre.openOffline)
      if (!capped) this.fail('covered-refused', `${c.n} of ${c.meter} was covered by the allowance and refused (journal of ${pre.entries})`)
    }
    if (!pre.covered && !asked && !pre.voidWaiting) this.fail('uncovered-unasked', `${c.n} of ${c.meter} was refused without asking, and no void wait runs`)
  }

  private describe(): void {
    const show = (op: JournalOp | SpendEntry): string => {
      if (op.kind === 'confirmed') return `confirmed:${op.entries.length}`
      if (op.kind === 'figures' || op.kind === 'activated' || op.kind === 'deactivated') return op.kind
      return `${op.kind}${'told' in op && op.told ? '!' : ''}:${this.label(op.id)}:${op.meter}:${op.n}`
    }
    this.trace.push(`  stored [${entriesOf(this.state).map(show).join(' ')}]`)
    for (const [i, p] of this.procs.entries()) this.trace.push(`  p${i} holds [${p.held().map(show).join(' ')}]`)
  }

  // --- what must hold between steps, and at the end -------------------------------------

  /** A void held in memory that is gone, though it neither landed nor reached the server: sixteen were held and the oldest went, or the journal found no room for it. */
  private accountVoids(): void {
    const stored = entriesOf(this.state)
    for (const [i, p] of this.procs.entries()) {
      const now = new Set(p.held().flatMap((op) => (op.kind === 'void' ? [op.id] : [])))
      const before = this.heldVoids[i] as Set<string>
      for (const id of before) {
        if (now.has(id) || stored.some((e) => e.id === id) || this.server.voided.has(id) || this.lostVoids.has(id)) continue
        if (before.size >= VOIDS || this.refusedVoids.has(id)) this.lostVoids.add(id)
        else this.fail('void-dropped', `a void held in memory is gone: ${this.label(id)} (${before.size} held, ${stored.length} stored)`)
      }
      this.heldVoids[i] = now
    }
  }

  /** The phantoms the server recorded and no void has taken back. */
  private outstanding(): { id: string; meter: string; n: number; full: boolean }[] {
    return this.phantoms.filter((x) => this.server.recorded.has(x.id) && !this.server.voided.has(x.id))
  }

  private async check(): Promise<void> {
    if (this.violation !== undefined) this.fail('void-replaced', this.violation)
    const stored = entriesOf(this.state)
    const ids = stored.map((e) => e.id)
    if (new Set(ids).size !== ids.length) this.fail('duplicate-id', 'the journal holds one id twice')
    if (stored.length > ENTRIES + this.toldOps) this.fail('journal-size', `${stored.length} entries stored, past the cap and what was told`)
    if (stored.filter((e) => e.kind === 'void').length > VOIDS) this.fail('void-cap', 'more voids stored than the cap')
    for (const [m, spec] of Object.entries(this.c.meters)) {
      const unsynced = unsyncedIn(stored, m)
      if (unsynced > spec.offline + (this.told[m] ?? 0)) this.fail('allowance', `${unsynced} of ${m} unsynced past its allowance ${spec.offline} and the ${this.told[m]} told`)
    }
    let holding = false
    for (const p of this.procs) {
      const held = p.held()
      if (held.filter((op) => op.kind === 'void').length > VOIDS) this.fail('unsaved-voids', 'a process holds more voids in memory than the cap')
      if (held.some((op) => op.kind === 'void' && 'told' in op && op.told === true)) this.fail('void-told', 'a void was marked told')
      if (held.length > ENTRIES + VOIDS + 16) this.fail('unsaved-size', `${held.length} changes held in memory`)
      if (held.length > 0) holding = true
    }
    this.accountVoids()
    // The server never holds more than the customer was told and the refusals it recorded: a spend counted twice shows here at once.
    for (const m of Object.keys(this.c.meters)) {
      const phantom = sum(this.outstanding().filter((x) => x.meter === m).map((x) => x.n))
      if (this.server.used(m) > (this.acked[m] ?? 0) + phantom) this.fail('counted-twice', `${m}: the server holds ${this.server.used(m)}, the customer was told ${this.acked[m]} (and ${phantom} refused but recorded)`)
    }
    // What was told while only memory held it excuses the allowance only while it is unreported: once a meter's journal drains, the loosening ends.
    for (const m of Object.keys(this.c.meters)) {
      if (unsyncedIn(stored, m) === 0 && !this.procs.some((p) => p.held().some((op) => 'meter' in op && op.meter === m && op.kind !== 'void'))) this.told[m] = 0
    }
    if (stored.length === 0 && !holding) this.toldOps = 0
  }

  /** The network and the disk come back, time passes, and every journal is reported: then the books are balanced. */
  private async converge(): Promise<void> {
    this.net = 'good'
    this.diskFailing = false
    this.rs = [0]
    this.rk = 0
    this.trueNow += 3 * HOUR
    this.server.now = Math.max(this.server.now, this.trueNow)
    await this.ensureActive()
    // A journal past 64 entries is reported 64 at a time, so more than one check-in each may be needed.
    for (let round = 0; round < 4 && (round === 0 || entriesOf(this.state).length > 0 || this.procs.some((p) => p.held().length > 0)); round += 1) {
      for (const p of this.procs) {
        const out = await this.settle([p.status(true)])
        if (!out[0]?.ok) this.fail('status-rejected', String((out[0] as { e: unknown }).e))
        this.accountVoids()
      }
    }
    if (this.violation !== undefined) this.fail('void-replaced', this.violation)
    if (entriesOf(this.state).length > 0) this.fail('journal-left', `the journal still holds ${JSON.stringify(this.state.spends)} after every process reported`)
    for (const p of this.procs) if (p.held().length > 0) this.fail('unsaved-left', 'a process still holds changes in memory')
    // A refusal the server recorded is taken back, unless that very void was lost as the contract allows: replaced by a newer one, dropped with a release, held by a process that ended, or never given room.
    for (const x of this.outstanding()) {
      if (!x.full && !this.lostVoids.has(x.id)) this.fail('void-lost', `${x.meter}: ${x.n} refused after the server recorded it (${this.label(x.id)}), and its void did not reach the server though nothing lost it`)
    }
    const shown: LicenseStatus[] = []
    for (const p of this.procs) shown.push(await p.status())
    for (const [m, spec] of Object.entries(this.c.meters)) {
      const net = this.server.used(m)
      const outstanding = sum(this.outstanding().filter((x) => x.meter === m).map((x) => x.n))
      const acked = this.acked[m] ?? 0
      if (net < acked - (this.lossAllowed[m] ?? 0) + outstanding) this.fail('lost', `${m}: the server holds ${net}, the customer was told ${acked} (and ${outstanding} refused but recorded)`)
      if (net > acked + outstanding) this.fail('counted-twice', `${m}: the server holds ${net}, the customer was told ${acked} (and ${outstanding} refused but recorded)`)
      const left = Math.max(0, spec.total - net)
      for (const status of shown) {
        const figure = status.meters?.[m]
        if (figure === undefined || figure.left !== left || figure.unsynced !== 0) this.fail('figures', `${m}: status shows ${JSON.stringify(figure)}, the server has ${left} left`)
      }
    }
  }
}

/** Run a case. Null when every property held. */
export async function runCase(c: Case, trace?: string[]): Promise<Failure | null> {
  const world = await World.create(c)
  world.tracing = trace !== undefined
  try {
    await world.run()
    return null
  } catch (e) {
    trace?.push(...world.trace)
    return e instanceof Failure ? e : new Failure('exception', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e))
  }
}

/** Run a case and give its whole trace, failing or not: what a replay is compared by. */
export async function traceOf(c: Case): Promise<string> {
  const world = await World.create(c)
  world.tracing = true
  let ended = ''
  try {
    await world.run()
  } catch (e) {
    ended = `\nfailed: ${e instanceof Error ? e.message : String(e)}`
  }
  return world.trace.join('\n') + ended
}
