/**
 * How the user-lock groups (`UserLockGroupName`) are answered by the reference,
 * from each vector's own JSON inputs, as `replay.ts` answers the others (and
 * with its conventions).
 */
import { mapServerError, typedFor } from '../src/wire.js'
import type { UserLockGroupInputs, UserLockGroupName } from './inputs.js'
import type { Group } from './replay.js'

export const USER_LOCK_GROUPS: { [G in UserLockGroupName]: Group<UserLockGroupInputs[G]> } = {
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
