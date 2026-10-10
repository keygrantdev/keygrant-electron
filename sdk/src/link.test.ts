import { describe, it, expect } from 'vitest'
import { referencedLink } from './link.js'

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
