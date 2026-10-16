/**
 * How the user-lock groups (`UserLockGroup`) are answered by the reference,
 * from each vector's own JSON inputs, as `replay.ts` answers the others (and
 * with its conventions). They come after every other group in the file.
 */
import { mapServerError, typedFor } from '../src/wire.js'
import type { GroupInputs, UserLockGroup } from './inputs.js'
import type { Group } from './replay.js'

export const USER_LOCK: { [G in UserLockGroup]: Group<GroupInputs[G]> } = {
  typedFor: {
    outputs: ['expect'],
    // An option that was not given is null in the file, and undefined to the reference.
    answer: (i) => ({ expect: typedFor({ ...(i.email !== null ? { email: i.email } : {}), ...(i.code !== null ? { code: i.code } : {}) }) }),
  },
  userLockErrors: {
    outputs: ['expect'],
    answer: (i) => ({ expect: mapServerError(i.error) }),
  },
}
