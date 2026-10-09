import { describe, it, expect, vi } from 'vitest'

// The CSPRNG, watched: every call still goes to node:crypto's own randomBytes.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})

import { randomBytes } from 'node:crypto'
import { newPurchaseSecret, referencedLink } from './pickup.js'

describe('newPurchaseSecret', () => {
  it("is the base64url (no padding) of 32 bytes from node:crypto's CSPRNG", () => {
    const watched = vi.mocked(randomBytes)
    const secret = newPurchaseSecret()
    expect(watched).toHaveBeenLastCalledWith(32)
    const bytes = watched.mock.results.at(-1)?.value as Buffer
    expect(bytes).toHaveLength(32)
    expect(secret).toBe(bytes.toString('base64url'))
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

/**
 * Two link cases that depend on the platform's URL type, so no vector holds
 * them: this SDK's own behaviour, pinned here.
 */
describe("referencedLink, where it follows the platform's URL normal form", () => {
  it('keeps a parameter whose name is percent-encoded, as written: only the name exactly client_reference_id is replaced', () => {
    expect(referencedLink('https://buy.stripe.com/x?client%5Freference_id=old', 'act_1')).toBe(
      'https://buy.stripe.com/x?client%5Freference_id=old&client_reference_id=act_1',
    )
  })

  it('takes a link of any scheme its URL parser reads as absolute, not only http and https', () => {
    expect(referencedLink('myapp://buy/sluice?plan=pro', 'act_1')).toBe('myapp://buy/sluice?plan=pro&client_reference_id=act_1')
  })
})
