/**
 * The `entitlementNumbers` group: a number as the server's JSON writes it
 * (`JSON.stringify`), read as an entitlement (`entitlementsOf`), and the bits
 * of the double it gives. A status compares numbers as numbers, and a port's
 * harness reads the file with the same reader as a lease, so a reader that
 * rounds wrongly agrees with itself there; bits it cannot round.
 */
import type { GroupInputs } from '../inputs.js'

/**
 * Numbers a reader that is not correctly rounded misreads (serde_json without
 * its `float_roundtrip` feature reads each a double away): every SDK must give
 * the nearest double, as JavaScript does.
 */
export const MISREAD = ['221.62324973788606', '975.1952520418383', '123456789012345680000']

/** Each number, by what it is, written as the server writes it. */
const NUMBERS: [string, number][] = [
  ['a whole number', 5],
  ['a negative whole number', -2],
  ['zero', 0],
  ['a fraction', 0.5],
  ['a negative fraction', -1.5],
  ['a tenth, which no double holds exactly', 0.1],
  ['a sum a double rounds', 0.1 + 0.2],
  ['a third', 1 / 3],
  ['a whole number past 2^31', 3_000_000_000],
  ['2^53, the last whole number every double before it holds', 2 ** 53],
  ['1e21, the first whole number JSON writes with an exponent', 1e21],
  ['a millionth of a tenth, written with an exponent', 1e-7],
  ['the largest double', Number.MAX_VALUE],
  ['the smallest normal double', 2.2250738585072014e-308],
  ['the largest subnormal double', 2.225073858507201e-308],
  ['the smallest subnormal double', Number.MIN_VALUE],
  ['17 significant digits, misread by a reader that is not correctly rounded', 221.62324973788606],
  ['16 significant digits, misread by a reader that is not correctly rounded', 975.1952520418383],
  ['a whole number past 2^64, misread by a reader that is not correctly rounded', 123456789012345680000],
]

export function entitlementNumbers(): GroupInputs['entitlementNumbers'][] {
  return NUMBERS.map(([name, value]) => ({ name, json: JSON.stringify(value) }))
}
