/**
 * The server a property test of `use()` runs the real `License` against (use.property.fixture.ts): what the
 * KeyGrant API does with a request that carries a spend or a report of unsynced ones, as the contract says
 * (sections 12.2 and 12.4): every report lands once by its id, an entry that grew adds what it grew by, a void
 * takes an online spend or a report back and keeps its id from counting later, and an answer names the entries it
 * holds. Test support only: never exported from the package, and left out of its declarations.
 */
import { signLease, type SignableMeters } from '@keygrant/shared'
import { PRODUCT } from './license.fixture.js'
import { KEY } from './meters.fixture.js'
import type { Confirmed, SpendReport } from './meter-types.js'

/** A meter the key holds. */
export interface MeterSpec {
  total: number
  offline: number
  resets: boolean
}

/** What the server did with one request. */
export interface Served {
  status: number
  json: unknown
  /** The id of a spend of its own that this request recorded: a `use` that landed. */
  spent?: string
}

/** A request body, as the SDK sends it. */
interface Body {
  activationId?: string
  meter?: string
  n?: number
  id?: string
  spends?: SpendReport[]
}

export class Server {
  /** What it holds by spend id: an online spend or a report, at the count it has. */
  readonly recorded = new Map<string, { meter: string; n: number }>()
  /** The ids a void took back, or was the first to name. */
  readonly voided = new Set<string>()
  /** The server's time (ms): it moves on by a millisecond with each request, so no two answers carry one time. */
  now: number
  private activations = 0

  constructor(
    readonly meters: Record<string, MeterSpec>,
    private readonly signingKey: CryptoKey,
    now: number,
  ) {
    this.now = now
  }

  /** What a meter has used: its recorded spends, whatever the allowance. */
  used(code: string): number {
    let sum = 0
    for (const held of this.recorded.values()) if (held.meter === code) sum += held.n
    return sum
  }

  left(code: string): number {
    const spec = this.meters[code]
    return spec === undefined ? 0 : Math.max(0, spec.total - this.used(code))
  }

  private figures(): Record<string, { left: number; total: number; offline: number; resets?: boolean }> {
    return Object.fromEntries(
      Object.entries(this.meters).map(([code, m]) => [code, { left: this.left(code), total: m.total, offline: m.offline, ...(m.resets ? { resets: true } : {}) }]),
    )
  }

  /** The lease the server signs now for an activation: the key's meters as they stand, valid for 60 days. */
  lease(aid: string): Promise<string> {
    const met = this.figures() as unknown as SignableMeters
    return signLease({ sub: KEY, product: PRODUCT, aid, model: 'subscription', lim: 3, major: 3, ent: {}, met, ttlSeconds: 60 * 86_400 }, this.signingKey, this.now)
  }

  /** Take a request's reports, and name the entries held after (the SDK contract, 12.2: always accepted). */
  private report(spends: SpendReport[] | undefined): Confirmed[] {
    const confirmed: Confirmed[] = []
    for (const e of spends ?? []) {
      if (this.voided.has(e.id)) {
        confirmed.push(e.void === true ? { id: e.id, void: true } : { id: e.id, n: e.n })
        continue
      }
      if (e.void === true) {
        this.recorded.delete(e.id)
        this.voided.add(e.id)
        confirmed.push({ id: e.id, void: true })
        continue
      }
      const held = this.recorded.get(e.id)
      if (held === undefined) this.recorded.set(e.id, { meter: e.meter, n: e.n })
      else if (e.n > held.n) held.n = e.n
      confirmed.push({ id: e.id, n: e.n })
    }
    return confirmed
  }

  /** What the server answers a request of `action`, and what it recorded. Synchronous in its effects. */
  async handle(action: string, body: Body): Promise<Served> {
    this.now += 1
    const confirmed = this.report(body.spends)
    const named = confirmed.length > 0 ? { spends: confirmed } : {}
    switch (action) {
      case 'use':
        return this.use(body, named)
      case 'validate':
        return { status: 200, json: { lease: await this.lease(body.activationId ?? ''), ...named } }
      case 'deactivate':
        return { status: 200, json: { released: true, ...named } }
      case 'activate': {
        this.activations += 1
        const aid = `act_${this.activations + 1}`
        return { status: 200, json: { lease: await this.lease(aid), activationId: aid } }
      }
      default:
        return { status: 404, json: { error: 'unknown' } }
    }
  }

  private use(body: Body, named: object): Served {
    const { meter = '', n = 0, id = '' } = body
    if (this.meters[meter] === undefined) return { status: 404, json: { error: 'unknown-meter', ...named } }
    if (this.recorded.has(id)) return { status: 200, json: { spent: true, meters: this.figures(), at: this.now, ...named } }
    if (n > this.left(meter)) return { status: 409, json: { error: 'used-up', left: this.left(meter), meters: this.figures(), at: this.now, ...named } }
    this.recorded.set(id, { meter, n })
    return { status: 200, json: { spent: true, meters: this.figures(), at: this.now, ...named }, spent: id }
  }
}
