import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { importVerifyingKeys } from '@keygrant/shared'
import { generate, VECTORS_PATH } from '../conformance/generate.js'
import { GROUPS } from '../conformance/replay.js'
import { FILES } from '../conformance/replay-files.js'
import { COVERAGE } from '../conformance/coverage.js'
import { FILE_COVERAGE } from '../conformance/coverage-files.js'

/**
 * `conformance/vectors.json` is what every KeyGrant SDK must answer, taken from
 * this SDK (the reference). It is regenerated here from the reference's own
 * functions and must equal the committed file: a change to the reference's
 * behaviour that is not carried into the vectors fails, so the other SDKs are
 * never held to answers the reference no longer gives.
 *
 * To accept a deliberate change: `pnpm --filter @keygrant/electron run conformance`,
 * then make every other SDK pass the new vectors.
 */

type Vector = Record<string, unknown> & { name?: string }
const committed = (): Record<string, unknown> => JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Record<string, unknown>

// Generating every vector signs and verifies hundreds of leases: well inside a second
// alone, but past vitest's five on a machine busy with other builds.
const HEAVY = { timeout: 60_000 }

describe('the SDK conformance vectors', () => {
  it('are what the reference SDK answers today', HEAVY, async () => {
    expect(JSON.parse(JSON.stringify(await generate()))).toEqual(committed())
  })

  it('are answered by the reference from nothing but their own JSON', HEAVY, async () => {
    /**
     * What a port's harness does: read each vector's inputs from the file and
     * answer them. A vector whose answer depends on something its JSON cannot
     * carry (an `undefined` that JSON drops) fails here, in the reference,
     * rather than in every port that tries to reproduce it.
     */
    const file = committed()
    const key = await importVerifyingKeys([file.publicJwk as JsonWebKey])
    const mismatches: string[] = []
    for (const [name, group] of Object.entries(GROUPS)) {
      for (const vector of file[name] as Vector[]) {
        const inputs = Object.fromEntries(Object.entries(vector).filter(([field]) => !group.outputs.includes(field)))
        const answered = JSON.parse(JSON.stringify(await group.answer(inputs, key))) as Record<string, unknown>
        for (const field of group.outputs) {
          if (JSON.stringify(answered[field]) !== JSON.stringify(vector[field])) mismatches.push(`${name}: ${vector.name ?? JSON.stringify(inputs)}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('hold every group with at least one vector, and nothing the replay does not know', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.sort()).toEqual(Object.keys(GROUPS).sort())
    for (const name of groups) expect((file[name] as unknown[]).length, name).toBeGreaterThan(0)
  })

  it('cover every outcome of every group, so no vector that is the only one to show one can go unnoticed', () => {
    /**
     * Each group's facets (`conformance/coverage.ts`, `coverage-files.ts`) map
     * a vector to the outcome it shows; the set over the group must be exactly
     * the one listed. Deleting the only test licence, the only expired lease
     * that keeps its claims, an error word, or one platform's machine ids
     * regenerates a file the first test accepts, and fails here.
     */
    const file = committed()
    expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(GROUPS).sort())
    const differences: string[] = []
    for (const [name, facets] of Object.entries(COVERAGE)) {
      for (const [facet, { of, expect: wanted }] of Object.entries(facets)) {
        const seen = [...new Set((file[name] as Vector[]).map(of))].sort()
        if (JSON.stringify(seen) !== JSON.stringify([...wanted].sort())) {
          differences.push(`${name} (${facet}): ${JSON.stringify(seen)}, not ${JSON.stringify([...wanted].sort())}`)
        }
      }
    }
    expect(differences).toEqual([])
  })

  it('give every vector every answer its group has', () => {
    // An answer left out would be compared as `undefined` by a harness that
    // reads it as a field, and pass for a port that answers nothing.
    const file = committed()
    const missing: string[] = []
    for (const [name, group] of Object.entries(GROUPS)) {
      for (const vector of file[name] as Vector[]) {
        for (const field of group.outputs) if (!(field in vector)) missing.push(`${name}: ${vector.name ?? JSON.stringify(vector)} has no ${field}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('the licence-file vectors', () => {
  it('are the last groups of the file, in their order, so every group before them is as it was', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.slice(-3)).toEqual(Object.keys(FILES))
  })

  it('tell every vector apart by its rule, so deleting any one of them fails the coverage', () => {
    const file = committed() as Record<string, Vector[] | undefined>
    for (const [name, facets] of Object.entries(FILE_COVERAGE)) {
      const rule = facets.rule ?? facets.outcome
      const vectors = file[name]
      if (rule === undefined || vectors === undefined) throw new Error(`${name}: no rule facet, or no vectors in the file`)
      expect(vectors.length, name).toBeGreaterThan(0)
      expect(new Set(vectors.map((v) => rule.of(v))).size, name).toBe(vectors.length)
    }
  })
})
