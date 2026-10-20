import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { importVerifyingKeys } from '@keygrant/shared'
import { VECTORS_PATH, WIRE_BODIES_PATH, generate } from '../conformance/generate.js'
import { wireBodies } from '../conformance/bodies.js'
import { GROUPS } from '../conformance/replay.js'
import { FILES } from '../conformance/replay-files.js'
import { METERS } from '../conformance/replay-meters.js'
import { USER_LOCK } from '../conformance/replay-user-lock.js'
import { PICKUP } from '../conformance/replay-pickup.js'
import { COVERAGE } from '../conformance/coverage.js'
import { FILE_COVERAGE } from '../conformance/coverage-files.js'
import { METER_COVERAGE } from '../conformance/coverage-meters.js'

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

/** How many groups the key-pickup vectors are, which close the file. */
const PICKUP_GROUP_COUNT = Object.keys(PICKUP).length
/** How many groups the metered-uses vectors are, just before them. */
const METER_GROUP_COUNT = Object.keys(METERS).length
/** How many groups come after the user-lock vectors. */
const AFTER_USER_LOCK = METER_GROUP_COUNT + PICKUP_GROUP_COUNT

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
    const vectors = committed()
    const key = await importVerifyingKeys([vectors.publicJwk as JsonWebKey])
    const mismatches: string[] = []
    for (const [name, group] of Object.entries(GROUPS)) {
      for (const vector of vectors[name] as Vector[]) {
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
    const vectors = committed()
    const groups = Object.keys(vectors).filter((k) => Array.isArray(vectors[k]) && k !== 'conventions')
    expect(groups.sort()).toEqual(Object.keys(GROUPS).sort())
    for (const name of groups) expect((vectors[name] as unknown[]).length, name).toBeGreaterThan(0)
  })

  it('cover every outcome of every group, so no vector that is the only one to show one can go unnoticed', () => {
    /**
     * Each group's facets (`conformance/coverage.ts`, `coverage-files.ts`) map
     * a vector to the outcome it shows; the set over the group must be exactly
     * the one listed. Deleting the only test licence, the only expired lease
     * that keeps its claims, an error word, or one platform's machine ids
     * regenerates a file the first test accepts, and fails here.
     */
    const vectors = committed()
    expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(GROUPS).sort())
    const differences: string[] = []
    for (const [name, facets] of Object.entries(COVERAGE)) {
      for (const [facet, { of, expect: wanted }] of Object.entries(facets)) {
        const seen = [...new Set((vectors[name] as Vector[]).map(of))].sort()
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
    const vectors = committed()
    const missing: string[] = []
    for (const [name, group] of Object.entries(GROUPS)) {
      for (const vector of vectors[name] as Vector[]) {
        for (const field of group.outputs) if (!(field in vector)) missing.push(`${name}: ${vector.name ?? JSON.stringify(vector)} has no ${field}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('the licence-file vectors', () => {
  it('are the groups just before the user-lock groups, in their order, so every group before them is as it was', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.slice(-5 - AFTER_USER_LOCK, -2 - AFTER_USER_LOCK)).toEqual(Object.keys(FILES))
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

describe('the user-lock vectors', () => {
  it('are the groups just before the metered-uses groups, in their order, so every group before them is as it was', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.slice(-2 - AFTER_USER_LOCK, -AFTER_USER_LOCK)).toEqual(Object.keys(USER_LOCK))
  })
})

describe('the metered-uses vectors', () => {
  it('are the groups just before the key-pickup groups, in their order, so every group before them is as it was', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.slice(-AFTER_USER_LOCK, -PICKUP_GROUP_COUNT)).toEqual(Object.keys(METERS))
  })

  it('keep the constants the ports need, beside the file’s own', () => {
    const constants = committed().constants as Record<string, unknown>
    expect(constants).toMatchObject({ MAX_METER_USES: 1_000_000_000, MAX_PENDING_SPENDS: 64, MAX_PENDING_VOIDS: 16, PENDING_MAX_MS: 15_552_000_000, USE_TIMEOUT_MS: 5_000 })
  })

  it('tell every vector apart by its rule, so deleting any one of them fails the coverage', () => {
    const file = committed() as Record<string, Vector[] | undefined>
    for (const [name, facets] of Object.entries(METER_COVERAGE)) {
      const rule = facets.rule
      const vectors = file[name]
      if (rule === undefined || vectors === undefined) throw new Error(`${name}: no rule facet, or no vectors in the file`)
      expect(vectors.length, name).toBeGreaterThan(0)
      expect(new Set(vectors.map((v) => rule.of(v))).size, name).toBe(vectors.length)
    }
  })
})

describe('the request bodies a License sends with a report', () => {
  it('are the committed file’s: regenerating them from a License over a fake adapter gives the file the worker’s test parses', HEAVY, async () => {
    expect(JSON.parse(JSON.stringify(await wireBodies()))).toEqual(JSON.parse(readFileSync(WIRE_BODIES_PATH, 'utf8')))
  })
})

describe('the key-pickup vectors', () => {
  it('are the last groups of the file, in their order, so every group before them is as it was', () => {
    const file = committed()
    const groups = Object.keys(file).filter((k) => Array.isArray(file[k]) && k !== 'conventions')
    expect(groups.slice(-PICKUP_GROUP_COUNT)).toEqual(Object.keys(PICKUP))
  })
})
