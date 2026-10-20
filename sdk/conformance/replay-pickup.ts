/**
 * How the key-pickup groups (`PickupGroup`) are answered by the reference, from
 * each vector's own JSON inputs, as `replay.ts` answers the others (and with its
 * conventions). They come after every other group in the file.
 */
import { chosenKey, pickedKeysOf, pickupAsk, pickupRefusal } from '../src/pickup.js'
import type { GroupInputs, PickupGroup } from './inputs.js'
import { plain, type Group } from './replay.js'

export const PICKUP: { [G in PickupGroup]: Group<GroupInputs[G]> } = {
  pickupAsks: {
    outputs: ['expect'],
    answer: (i) => ({ expect: pickupAsk(i.email, i.code) }),
  },
  pickupRefusals: {
    outputs: ['expect'],
    answer: (i) => ({ expect: pickupRefusal(i.json) }),
  },
  pickedKeys: {
    outputs: ['expect'],
    answer: (i) => ({ expect: plain(pickedKeysOf(i.json)) }),
  },
  pickupChoices: {
    outputs: ['expect'],
    answer: (i) => ({ expect: chosenKey(i.keys, i.major, i.now) }),
  },
}
