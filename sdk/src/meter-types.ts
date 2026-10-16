/**
 * The types of metered uses (the SDK contract, section 12): what `use()` answers, what `status().meters`
 * shows, and what the stored state keeps of them. Named from types.ts too, where the SDK's other types are.
 */

/** One meter of a key as `status().meters` shows it. */
export interface MeterStatus {
  /** What is left: the uses the lease said were left, less what this device spent since and has not reported (never below 0). */
  left: number
  /** The uses the key holds, for good or for this billing period. */
  total: number
  /** How many uses this device may spend while KeyGrant cannot be reached. */
  offline: number
  /** Uses this device spent that KeyGrant has not heard of yet. */
  unsynced: number
  /** True for a meter that comes back to its full uses each billing period. */
  resets: boolean
}

/**
 * Why `use()` did not spend. `invalid-amount`: `n` is not a whole number from 1 to 1,000,000,000 (a bug in
 * the app; nothing was asked). `no-meter`: the key has no meter of that code. `used-up`: fewer left than
 * asked (`left` says how many). `offline-limit`: KeyGrant could not be reached and the spend is past this
 * device's offline allowance for the meter, or past what it knows is left. `not-licensed`: no key's lease
 * licenses this build on this device (a trial and an offline licence file have no meters). `storage`: the
 * state could not be read just now. `revoked`, `upgrade`, `outdated`, `device`: the server's verdict on
 * the key, this build or this device, as `status()` says it.
 */
export type UseError =
  | 'invalid-amount'
  | 'no-meter'
  | 'used-up'
  | 'offline-limit'
  | 'not-licensed'
  | 'storage'
  | 'revoked'
  | 'upgrade'
  | 'outdated'
  | 'device'

/**
 * What `use(meter, n)` did. `left` is what is left of the meter now, net of this device's unsynced spends;
 * `offline` is true when KeyGrant could not be asked and the spend came from the offline allowance. On a
 * refusal, `left` is given for `used-up` and `offline-limit`.
 */
export type UseResult = { ok: true; left: number; offline?: true } | { ok: false; error: UseError; left?: number }

/**
 * A spend this device made that KeyGrant has not confirmed (the journal, `StoredState.spends`).
 * `offline`: spends made with no request sent, one entry for each meter, its `n` growing; `unanswered`: one
 * spend whose own request got no answer (the server may hold it); `void`: one spend whose request got no answer
 * and that was then refused, reported so the server takes it back if it recorded it.
 */
export interface SpendEntry {
  id: string
  meter: string
  n: number
  /** When (guarded device clock, ms) the entry was opened. */
  at: number
  kind: 'offline' | 'unanswered' | 'void'
}

/** A meter's figures as the newest `use` answer gave them (`StoredState.meterFigures`); `at` is the server's time (ms). */
export interface MeterFigure {
  left: number
  total: number
  offline: number
  resets: boolean
  at: number
}

/** A meter's figures as a lease signs them or an answer gives them, without the time of the answer. */
export interface BaseFigure {
  left: number
  total: number
  offline: number
  resets: boolean
}

/** An entry of the journal as a report carries it (the SDK contract, 12.2): a void is marked. */
export interface SpendReport {
  id: string
  meter: string
  n: number
  at: number
  void?: true
}

/** A report the server names as recorded: how many it holds of a spend, or that it took a void. */
export type Confirmed = { id: string; n: number } | { id: string; void: true }
