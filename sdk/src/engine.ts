import { importVerifyingKeys, publicKeyBytes, verifyLease, type VerifyResult, type VerifyingKey } from '@keygrant/shared'
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  createFileStorage,
  defaultStoragePath,
  legacyStoragePath,
  fetchHttp,
  noopRegistry,
  nodeFingerprinter,
  systemClock,
} from './adapters.js'
import type { Adapters, DeviceKind, LicenseConfig, LicenseStatus, StoredState } from './types.js'
import { DeviceIdentityReader, type Device } from './device.js'
import { MACHINE_ID_TIMEOUT_MS } from './machine-id.js'
import { checkLease, majorOf, merged, trialLeaseOf, type Asked, type Basis, type LeaseCheck, type TrialLease } from './offline.js'
import { clockCorrection, guardedNow, savedLastSeen } from './clock.js'
import { renewalOutcome, type ValidateResponse } from './renewal.js'
import { graceTimer, parseLeaseBody, withTimeout, type Renewal } from './wire.js'

/**
 * How long past its HTTP bound a call may hold the next one waiting (`serial`):
 * room for the device read and the storage reads and writes around its one
 * request. A call that may make a second, shorter request (`startTrial()`: a
 * claim bounded by STATUS_CHECK_TIMEOUT_MS, then its trial ask) is given that
 * bound on top (`serial`'s `extraMs`).
 */
export const LOCK_GRACE_MS = 15_000

/**
 * The machinery under `License` (license.ts): the adapters, one call at a time,
 * every request bounded, the stored state and its clock guard, and the online
 * validate with what its answer does to the stored state. `License` decides
 * when to go online and what to answer.
 */
export abstract class Engine {
  protected readonly product: string
  protected readonly major: number
  protected readonly a: Adapters
  private readonly base: string
  /** The product's public keys, as configured (`LicenseConfig.publicJwks`). */
  private readonly publicJwks: readonly JsonWebKey[]
  /** The key set, imported once with each key's id (`keySet`). */
  private verifyingKeys?: Promise<VerifyingKey[]>
  /** Who this device is (`device`). */
  private deviceReader?: DeviceIdentityReader
  /** How long a request may take when the call names no bound of its own. */
  private readonly httpTimeoutMs: number
  /** Whether licences are held to their device (`LicenseConfig.deviceHold`). */
  private readonly deviceHold: boolean
  /** The last call queued: when it started running, and when it settled (`serial`). */
  private last: { started: Promise<{ graceOver: Promise<void> }>; settled: Promise<void> } = {
    started: Promise.resolve({ graceOver: Promise.resolve() }),
    settled: Promise.resolve(),
  }
  /** Calls running with writes allowed that have not settled yet (`serial`). */
  private writing = 0

  constructor(config: LicenseConfig) {
    this.product = config.product
    this.base = config.apiBaseUrl.replace(/\/$/, '')
    // As the server reads it (`majorOf`): one reading, used wherever the major is.
    this.major = majorOf(config.major)
    this.publicJwks = keysOf(config)
    this.httpTimeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
    this.deviceHold = config.deviceHold ?? true
    const a = config.adapters ?? {}
    this.a = {
      storage:
        a.storage ??
        createFileStorage(defaultStoragePath(config.product), { migrateFrom: legacyStoragePath(config.product) }),
      registry: a.registry ?? noopRegistry(),
      clock: a.clock ?? systemClock(),
      fingerprint: a.fingerprint ?? nodeFingerprinter(),
      http: a.http ?? fetchHttp(),
    }
  }

  /**
   * Run `work` once every call before it on this instance has finished. The
   * public calls each read the stored state, may ask the server, and write the
   * state back; an app that calls `status()` from several places at once had
   * them overlap, so one could write back a snapshot taken before another's
   * answer (bringing back a lease the server had just refused) and both asked
   * the server the same question. In turn, each starts from what the last one
   * left, and the second of two overlapping checks finds it already answered.
   *
   * A call waits for the one before it to settle, but not past the HTTP bound
   * plus LOCK_GRACE_MS from when that one STARTED running (not from when this
   * one was queued, which let a third call overlap a second on a slow network
   * with nothing stuck; `extraMs` more for a call that may make a second
   * request). Every request is bounded (`post`), but the storage,
   * fingerprint and registry adapters are not: cutting a storage write short
   * could leave it half-written. So a call stuck on one is left to finish on
   * its own, and the calls behind it go ahead READ-ONLY (`readOnly` true): they
   * answer from what is stored, with no ask and no write, for as long as any
   * call before them is still unsettled. A write of theirs could not be kept
   * safe anyway: the stuck call may be inside `storage.write` with a whole
   * state taken before them, which lands after theirs and reverts it, and the
   * storage interface has no compare-and-set to refuse it. Not writing is the
   * only way a late write cannot undo anything.
   */
  protected serial<T>(work: (readOnly: boolean) => Promise<T>, extraMs = 0): Promise<T> {
    const prev = this.last
    let markStarted: (value: { graceOver: Promise<void> }) => void = () => undefined
    const started = new Promise<{ graceOver: Promise<void> }>((resolve) => {
      markStarted = resolve
    })
    const run = (async () => {
      // The grace runs from when the call before started, however late this
      // one was queued: it is that call's timer, begun when it began.
      const { graceOver } = await prev.started
      await Promise.race([prev.settled, graceOver])
      const readOnly = this.writing > 0
      if (!readOnly) this.writing += 1
      const grace = graceTimer(this.httpTimeoutMs + LOCK_GRACE_MS + extraMs)
      markStarted({ graceOver: grace.over })
      try {
        return await work(readOnly)
      } finally {
        if (!readOnly) this.writing -= 1
        grace.cancel()
      }
    })()
    this.last = { started, settled: run.then(() => undefined, () => undefined) }
    return run
  }

  /**
   * POST to the product's endpoint, ALWAYS bounded: by `timeoutMs`, else by the
   * configured `httpTimeoutMs`. The bound is passed to the adapter and also
   * kept by the SDK itself, so an adapter that ignores it cannot hold a call,
   * and with it every call queued behind it, open.
   */
  protected post(action: string, body: unknown, timeoutMs?: number) {
    const url = `${this.base}/v1/products/${this.product}/${action}`
    const bound = timeoutMs ?? this.httpTimeoutMs
    return withTimeout(this.a.http.post(url, body, { timeoutMs: bound }), bound)
  }

  protected verify(lease: string, now: number): Promise<VerifyResult> {
    return this.keySet().then((keys) => verifyLease(lease, keys, now))
  }

  /**
   * The ids of the keys this build carries (`kid`, each key's thumbprint), in
   * the order configured: sent with each activation, validate and claim
   * (`kids`), so the product's dashboard can count the devices whose builds
   * do not carry a key yet.
   */
  protected async keyIds(): Promise<string[]> {
    return (await this.keySet()).map((k) => k.kid)
  }

  private keySet(): Promise<VerifyingKey[]> {
    this.verifyingKeys ??= importVerifyingKeys(this.publicJwks)
    return this.verifyingKeys
  }

  /**
   * A licence lease verified offline and held to this product and build, and to
   * the key and activation it is for, on this device (offline.ts `checkLease`).
   */
  protected async evaluate(
    lease: string,
    now: number,
    holder: { key?: string; activationId?: string; deviceKind?: DeviceKind },
  ): Promise<LeaseCheck> {
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, holder.deviceKind)
    const bound = { key: holder.key ?? '', activationId: holder.activationId ?? '', ...device }
    return checkLease(await this.verify(lease, now), this.product, this.major, bound)
  }

  /**
   * A trial lease verified offline, for this product and this device, with the
   * end it was signed to (ms) and its entitlements when it is valid (offline.ts
   * `trialLeaseOf`).
   */
  protected async trialLease(lease: string, now: number, installKind?: DeviceKind): Promise<TrialLease> {
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, installKind)
    return trialLeaseOf(await this.verify(lease, now), this.product, device)
  }

  /**
   * Who this device is, read for at most about `timeoutMs`, on an install keyed
   * as `installKind`, held to its device as configured (`deviceHold`): device.ts
   * `deviceFrom`.
   */
  protected async device(timeoutMs: number, installKind?: DeviceKind): Promise<Device> {
    this.deviceReader ??= new DeviceIdentityReader(this.a.fingerprint)
    return this.deviceReader.read(timeoutMs, installKind, this.deviceHold)
  }

  /** The install's kind as it bears on this device: none when nothing is held (`deviceHold` false). */
  protected installKind(stored: DeviceKind | undefined): DeviceKind | undefined {
    return this.deviceHold ? stored : undefined
  }

  /** The stored state; `readOnly` behind a call that has not finished, so the read writes nothing either. */
  protected async load(readOnly = false): Promise<StoredState> {
    return (await this.a.storage.read({ readOnly })) ?? {}
  }

  /**
   * Persist a patch onto the state as it is stored NOW, not onto a snapshot a
   * call took earlier, so a later write in the same call never undoes an
   * earlier one's fields; and advance the monotonic clock guard, unless the
   * guard is being brought back on the server's evidence (`guard`, from
   * `serverNow`). Through the storage's `update` when it has one, which
   * merges the patch again onto a state another process saved meanwhile.
   *
   * What the patch is (`basis`: an answer to an ask, a note about an
   * activation, a trial answer) decides what of it lands on a state another
   * process changed meanwhile (offline.ts `merged`).
   */
  protected async save(patch: Partial<StoredState>, guard?: number, basis?: Basis): Promise<void> {
    const merge = (latest: StoredState): StoredState => ({
      ...merged(latest, patch, basis),
      lastSeen: savedLastSeen(latest.lastSeen, this.a.clock.now(), guard),
    })
    const { storage } = this.a
    if (storage.update) return storage.update(merge)
    await storage.write(merge(await this.load()))
  }

  /**
   * A save for `status()` and `startTrial()`, whose failure fails nothing: the
   * answer stands (the server's, when it gave one). The write is atomic, so a
   * failed one left the stored state as it was, and the next call writes again.
   * Whether it was saved.
   */
  protected async saveBestEffort(patch: Partial<StoredState>, guard?: number, basis?: Basis): Promise<boolean> {
    return this.save(patch, guard, basis).then(
      () => true,
      () => false,
    )
  }

  /** Never earlier than the highest wall-clock ever seen (anti clock-rollback). */
  protected effectiveNow(state: StoredState): number {
    return guardedNow(this.a.clock.now(), state.lastSeen)
  }

  /**
   * `now` for judging a lease the server has just signed, with the clock guard
   * reconciled to it. The guard only moves forward, so a clock that once
   * jumped ahead (a dead CMOS battery, a mistyped date) and was corrected left
   * it there, and every lease, a fresh one included, read as expired even
   * online. The server's signing time (`iat`) is better evidence than the
   * guard: when the guard is more than CLOCK_TOLERANCE_MS past it, the guard
   * comes back to the device clock, never below `iat`.
   *
   * Only a lease the server signed FOR THIS DEVICE, now, can move it: its
   * signature is checked first, it must name this key (`sub`) and this
   * activation (`aid`), and be no older than the lease the device already
   * holds. Rewinding the clock offline still meets the guard; lowering it
   * would take a replayed response for this very activation, at least as new
   * as the one it holds, over intercepted TLS.
   */
  protected async serverNow(
    lease: string,
    mine: { key: string; activationId: string },
    save: (patch: Partial<StoredState>, guard?: number) => Promise<void> = (patch, guard) => this.save(patch, guard),
  ): Promise<number> {
    const stored = await this.load()
    const now = this.effectiveNow(stored)
    const claims = (await this.verify(lease, now)).claims
    const heldIat = stored.lease ? (await this.verify(stored.lease, now)).claims?.iat : undefined
    const corrected = clockCorrection({ clockNow: this.a.clock.now(), lastSeen: stored.lastSeen, claims, heldIat, ...mine })
    if (corrected === null) return now
    await save({}, corrected)
    return corrected
  }

  /** Attempt an online validate; returns a status on a definitive answer, else null. */
  protected async tryRenew(state: StoredState, timeoutMs?: number): Promise<LicenseStatus | null> {
    const renewal = await this.renew(state, timeoutMs)
    return renewal.answered ? renewal.status : null
  }

  /**
   * An online validate, and whether the server gave a verdict. What its answer
   * saves and says is renewal.ts `renewalOutcome`: any verdict (a lease, a
   * refusal, a body it could not use) records the major it was sent as heard
   * (`checkedMajor`), so the check of a newer major is not made again for it;
   * an ask that came back without a lease starts the wait before the SDK asks
   * again on its own (`askDue`): RETRY_UNANSWERED_MS when nothing answered at
   * all (no network, a timeout), ASK_AGAIN_MS when the server did (a refusal, a
   * 5xx, a 429, an answer it could not use).
   */
  protected async renew(state: StoredState, timeoutMs?: number): Promise<Renewal> {
    // The wait runs on the device clock, as `askDue` reads it; the answer is
    // stamped by the guarded one, which a clock put back does not move back,
    // so an answer asked for later still reads as later to another process.
    const askedAt = this.a.clock.now()
    const asked: Asked = { at: this.effectiveNow(state), activationId: state.activationId, seen: state.verdictAt }
    // A machine id read here keys this install from now on (`deviceKind`):
    // written with whatever this ask writes, as the seat is re-keyed by it.
    const device = await this.device(MACHINE_ID_TIMEOUT_MS, state.deviceKind)
    // Outside the request's try: a key set that cannot be imported is the app's
    // configuration, never an unanswered check-in.
    const kids = await this.keyIds()
    let response: ValidateResponse | null
    try {
      response = await this.post('validate', { ...this.validateBody(state, device), kids }, timeoutMs)
    } catch {
      response = null
    }
    const judged = await this.judgeFresh(state, response)
    const { keptMajor, key } = state
    const outcome = renewalOutcome({ response, ...judged, askedAt, major: this.major, key, keptMajor, device })
    // Saved as the answer to its ask; a save that fails leaves the answer standing (`saveBestEffort`).
    await this.saveBestEffort(outcome.patch, undefined, { answer: asked })
    return outcome.answered ? { answered: true, status: outcome.status } : { answered: false }
  }

  /**
   * The lease a validate's 200 carried, checked on this device (`evaluate`) as
   * of the server's time (`serverNow`, the clock guard brought back best-effort:
   * the server's time even when the state cannot be read or saved just now);
   * no check for any other answer. With the time it was judged at.
   */
  private async judgeFresh(
    state: StoredState,
    response: ValidateResponse | null,
  ): Promise<{ check?: LeaseCheck; now: number }> {
    const lease = response?.status === 200 ? parseLeaseBody(response.json).lease : undefined
    if (!lease) return { now: this.effectiveNow(state) }
    const holder = { key: state.key ?? '', activationId: state.activationId ?? '', deviceKind: state.deviceKind }
    return this.judged(lease, holder, this.effectiveNow(state))
  }

  /**
   * A lease the server just answered, checked for `holder` on this device
   * (`evaluate`) as of the server's time (`serverNow`, the clock guard brought
   * back best-effort; `fallbackNow` when the state cannot be read or saved
   * just now). With the time it was judged at.
   */
  protected async judged(
    lease: string,
    holder: { key: string; activationId: string; deviceKind?: DeviceKind },
    fallbackNow: number,
  ): Promise<{ check: LeaseCheck; now: number }> {
    const saveGuard = async (patch: Partial<StoredState>, guard?: number) => {
      await this.saveBestEffort(patch, guard)
    }
    const mine = { key: holder.key, activationId: holder.activationId }
    const now = await this.serverNow(lease, mine, saveGuard).catch(() => fallbackNow)
    return { check: await this.evaluate(lease, now, holder), now }
  }

  /**
   * A validate's body. With every fingerprint this device answers to, when it
   * can tell, so the server refuses a licence file copied from another machine
   * (`device`) before it touches the seat; with none when it cannot tell this
   * time, so a slow read never costs an honest device its renewal.
   */
  private validateBody(state: StoredState, device: Device) {
    return {
      key: state.key,
      activationId: state.activationId,
      major: this.major,
      ...(state.keptMajor !== undefined ? { keptMajor: state.keptMajor } : {}),
      ...(device.canTell ? { fingerprints: device.fingerprints } : {}),
      ...(device.canTell && device.kind ? { fingerprintKind: device.kind } : {}),
    }
  }
}

/**
 * The key set a configuration gives: `publicJwks`, or `publicJwk` as a set of
 * one. Neither, both, an empty set, or a key that is not an Ed25519 public JWK
 * is a configuration the SDK cannot verify a lease with, and throws.
 */
function keysOf(config: Pick<LicenseConfig, 'publicJwk' | 'publicJwks'>): readonly JsonWebKey[] {
  const { publicJwk, publicJwks } = config
  if (publicJwk !== undefined && publicJwks !== undefined) throw new Error('KeyGrant: give publicJwks or publicJwk, not both')
  // A pasted `{"keys": [...]}` (what /pubkey answers) is refused by name: its `keys` is the array.
  if (publicJwks !== undefined && !Array.isArray(publicJwks)) {
    throw new Error('KeyGrant: publicJwks is an array of JWKs: the keys of /pubkey\'s answer')
  }
  const keys = publicJwks ?? (publicJwk !== undefined ? [publicJwk] : [])
  if (keys.length === 0) throw new Error('KeyGrant: give the product\'s public keys (publicJwks)')
  // Each key checked now, when the app is built and run, not at the first lease or check-in.
  keys.forEach((jwk, i) => {
    try {
      publicKeyBytes(jwk)
    } catch (e) {
      throw new Error(`KeyGrant: public key ${i + 1} cannot be used: ${(e as Error).message}`)
    }
  })
  return keys
}
