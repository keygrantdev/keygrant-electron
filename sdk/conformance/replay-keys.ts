/**
 * How the key-set groups (`KeyGroup`) are answered by the reference, from each
 * vector's own JSON inputs, as `replay.ts` answers the others (and with its
 * conventions). They come after every other group in the file.
 */
import { entitlementsOf, importVerifyingKeys, keyId, verifyLease } from '@keygrant/shared'
import { grants } from '../src/entitlements.js'
import type { GroupInputs, KeyGroup } from './inputs.js'
import { verified, type Group } from './replay.js'

export const KEYS: { [G in KeyGroup]: Group<GroupInputs[G]> } = {
  keyIds: {
    outputs: ['expect'],
    // null for a JWK every SDK refuses (`publicKeyBytes`).
    answer: async (i) => ({ expect: await keyId(i.jwk as JsonWebKey).catch(() => null) }),
  },
  keySets: {
    outputs: ['kids', 'verify'],
    async answer(i) {
      const set = await importVerifyingKeys(i.keys)
      return { kids: set.map((k) => k.kid), verify: verified(await verifyLease(i.token, set, i.now)) }
    },
  },
  grants: {
    outputs: ['expect'],
    answer: (i) => ({ expect: grants(entitlementsOf(i.ent), i.code) }),
  },
}
