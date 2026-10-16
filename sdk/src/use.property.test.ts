import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runCase, traceOf, type Call, type Case, type Failure, type Net, type Preloaded, type Step } from './property-world.fixture.js'
import type { MeterSpec } from './property-server.fixture.js'
import { FOUND } from './property-cases.fixture.js'

/**
 * A property test of `use()` over the real `License`: seeded random sequences of spends, check-ins and releases,
 * from two processes of the app over one state file, against a server whose answers are lost, late, refused or
 * lost after it has recorded the spend, with a disk that refuses its writes and a device clock that jumps forward
 * and back (the SDK contract, section 12). The properties (property-world.fixture.ts):
 *
 * - `use()` and `status()` never reject;
 * - a spend the offline allowance covers is refused only for the journal's size, and asks the server unless a
 *   wait runs (12.5);
 * - a spend it does not cover is never refused without asking, unless a void under a minute old stands (by the
 *   device clock too), and never asks while one does;
 * - the stored journal holds no more than 64 entries (but for the spends the customer was told were made while
 *   only memory could hold them) and 16 voids, and a process holds no more than 16 voids in memory, none of
 *   them marked told;
 * - offline, the unsynced spends of a meter never pass its allowance, those same told spends apart;
 * - the server never holds more than the customer was told and the refusals it recorded, at any step; once
 *   everything is reported it holds every spend the customer was told was made, once (but for what the contract
 *   lets a release or the end of a process drop unreported), a spend they were refused after it recorded it is
 *   there only when nothing could have lost its void (a sixteenth void replacing the oldest, a full journal, a
 *   process that ended, a release), and every status shows what the server has left;
 * - what `use()` answers as `left` is the figure less the unsynced less the spend when made offline, and never
 *   more than the server has when made online (12.4).
 *
 * The oracle takes its constants, figures and waits from the contract, not from the code it judges. A replayed
 * case runs the same way every time (a test below holds it to that), which is what lets a failing one be shrunk and kept.
 * `PROPERTY_RUNS` and `PROPERTY_SEED` choose how many sequences run and from which seed: the default is what the
 * suite affords, a hunt is `PROPERTY_RUNS=30000`. A failing case is shrunk and printed as data, with what
 * happened: add it to property-cases.fixture.ts as a named case.
 */

/** A seeded generator (mulberry32): the same seed, the same case. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MINUTE = 60_000
const HOUR = 3_600_000

function generate(seed: number): Case {
  const rand = seeded(seed)
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const meters: Record<string, MeterSpec> = {
    exports: { total: int(8, 150), offline: int(1, 12), resets: false },
    renders: { total: int(3, 40), offline: 0, resets: true },
    credits: { total: int(4, 60), offline: int(0, 6), resets: false },
  }
  const code = () => (rand() < 0.1 ? 'ghost' : pick(['exports', 'exports', 'renders', 'credits']))
  const amount = () => (rand() < 0.7 ? 1 : rand() < 0.8 ? int(2, 5) : rand() < 0.7 ? int(6, 14) : 500)
  const draws = () => Array.from({ length: 6 }, rand)
  const call = (p = int(0, 1), not?: string): Call => {
    let meter = code()
    while (meter === not) meter = code()
    return { p, meter, n: amount() }
  }

  // A storm: sixteen voids or one short of it, an outage, and spends the allowance cannot cover a minute apart: the cap is reached.
  const storm = rand() < 0.12
  // A journal past the cap, which a release reports 64 of.
  const overfull = !storm && rand() < 0.06
  const preload: Preloaded[] = []
  if (storm || overfull || rand() < 0.4) {
    const offline = ['exports', 'renders', 'credits'].filter(() => rand() < 0.3)
    // How many of the entries are voids is drawn once: sixteen or one short of it in a storm, else none to sixteen. They are then ordered with the rest, oldest first.
    const voids = storm ? int(14, 16) : overfull ? int(0, 13) : int(0, 16)
    const count = overfull ? int(65, 70) : Math.min(storm ? voids + int(0, 6) : pick([1, 2, 3, 5, 8, 20, 40, 55, 62, 64]), 64 - offline.length)
    for (let i = 0; i < count; i += 1) {
      const kind = i < voids ? 'void' : 'unanswered'
      preload.push({ meter: pick(['exports', 'renders', 'credits']), n: int(1, 2), kind, agoMs: pick(storm ? [5 * MINUTE, 2 * HOUR, 20 * HOUR] : [1_000, 30_000, 5 * MINUTE, 2 * HOUR, 20 * HOUR]), recorded: rand() < 0.5 })
    }
    for (const m of offline) preload.push({ meter: m, n: int(1, 3), kind: 'offline', agoMs: pick([5 * MINUTE, 2 * HOUR]), recorded: rand() < 0.5 })
    preload.sort((a, b) => b.agoMs - a.agoMs)
    // Past the cap, the newest entries are voids: the release carries 64 and leaves these behind.
    if (overfull) for (let k = int(1, 3); k > 0; k -= 1) preload.push({ meter: pick(['exports', 'renders', 'credits']), n: 1, kind: 'void', agoMs: 500, recorded: rand() < 0.7 })
  }

  const steps: Step[] = storm
    ? [{ t: 'net', mode: 'down' }, { t: 'repeat', call: { p: int(0, 1), meter: 'renders', n: 1 }, times: int(3, 8), gapMs: 61_000, r: draws() }]
    : overfull
      ? [{ t: 'net', mode: 'good' }, { t: 'deactivate', p: int(0, 1), r: draws() }]
      : []
  for (let i = int(8, 26); i > 0; i -= 1) {
    const x = rand()
    if (x < 0.3) steps.push({ t: 'use', calls: [call()], r: draws() })
    else if (x < 0.34) steps.push({ t: 'repeat', call: call(), times: int(2, 14), gapMs: pick([10_000, 61_000, 5 * MINUTE, 70 * MINUTE]), r: draws() })
    else if (x < 0.42) steps.push({ t: 'use', calls: [call(0), call(1)], r: draws() })
    else if (x < 0.48) {
      const first = call()
      steps.push({ t: 'use', calls: [first, call(first.p, first.meter)], r: draws() })
    } else if (x < 0.53) steps.push({ t: 'use', calls: [call()], status: { p: int(0, 1), force: rand() < 0.7 }, r: draws() })
    else if (x < 0.64) steps.push({ t: 'status', p: int(0, 1), force: rand() < 0.5, r: draws() })
    else if (x < 0.78) steps.push({ t: 'wait', ms: pick([1_000, 20_000, 59_000, 61_000, 5 * MINUTE, 70 * MINUTE, 3 * HOUR, 26 * HOUR]) })
    else if (x < 0.84) steps.push({ t: 'jump', ms: pick([30_000, 10 * MINUTE, 2 * HOUR, 30 * HOUR, -30_000, -10 * MINUTE, -2 * HOUR, -30 * HOUR]) })
    else if (x < 0.92) steps.push({ t: 'net', mode: pick<Net>(['good', 'down', 'down', 'flaky', 'flaky']) })
    else if (x < 0.97) steps.push({ t: 'disk', failing: rand() < 0.6 })
    else if (x < 0.985) steps.push({ t: 'restart', p: int(0, 1) })
    else steps.push({ t: 'deactivate', p: int(0, 1), r: draws() })
  }
  // A release after an outage: spends made while the disk refused, the disk back, and a deactivate, which must carry them.
  if (rand() < 0.1) {
    const p = int(0, 1)
    steps.push(
      { t: 'net', mode: 'down' },
      { t: 'disk', failing: true },
      { t: 'use', calls: [{ p, meter: pick(['exports', 'credits']), n: 1 }], r: draws() },
      { t: 'use', calls: [{ p, meter: 'exports', n: 1 }], r: draws() },
      { t: 'disk', failing: false },
      { t: 'net', mode: 'good' },
      { t: 'deactivate', p, r: draws() },
    )
  }
  return { seed, meters, preload, steps }
}

/** A failing case with steps taken out while it fails the same way: the shortest sequence that shows the bug. */
async function shrink(c: Case, failure: Failure): Promise<Case> {
  let best = c
  for (let size = Math.ceil(best.steps.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at < best.steps.length; ) {
      const trial = { ...best, steps: [...best.steps.slice(0, at), ...best.steps.slice(at + size)] }
      const again = await runCase(trial)
      if (again !== null && again.invariant === failure.invariant) best = trial
      else at += size
    }
    if (size === 1) break
  }
  const lean = { ...best, preload: [] as Preloaded[] }
  const bare = await runCase(lean)
  return bare !== null && bare.invariant === failure.invariant ? lean : best
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('use(), over random sequences', () => {
  const runs = Number(process.env.PROPERTY_RUNS ?? 1500)
  const first = Number(process.env.PROPERTY_SEED ?? 1)

  it(`keeps every property of the contract over ${runs} seeded sequences`, async () => {
    // A seed or a count that is not a whole number would run nothing, and pass.
    if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(first)) throw new Error(`PROPERTY_RUNS and PROPERTY_SEED must be whole numbers: ${process.env.PROPERTY_RUNS} and ${process.env.PROPERTY_SEED}`)
    let ran = 0
    for (let seed = first; seed < first + runs; seed += 1) {
      const c = generate(seed)
      const failure = await runCase(c)
      ran += 1
      if (failure === null) continue
      const small = await shrink(c, failure)
      const trace: string[] = []
      const again = await runCase(small, trace)
      throw new Error(`seed ${seed}: ${failure.message}\nshrunk to ${small.steps.length} steps (${again?.message ?? 'no longer fails'}):\n${JSON.stringify(small)}\n${trace.join('\n')}`)
    }
    expect(ran).toBe(runs)
  }, 60_000 + runs * 40)
})

describe('a case replayed', () => {
  it('runs the same way every time, with two processes at once: the same requests, answers and journals', async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const c = generate(seed)
      const first = await traceOf(c)
      for (let again = 0; again < 3; again += 1) expect(await traceOf(c), `seed ${seed}`).toBe(first)
    }
  }, 60_000)
})

describe('the cases the property test found', () => {
  it.each(FOUND.map((f) => [f.name, f.found] as const))('%s', async (_name, found) => {
    const failure = await runCase(found)
    expect(failure?.message).toBeUndefined()
  })
})
