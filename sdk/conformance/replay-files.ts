/**
 * How the licence-file groups (`FileGroup`) are answered by the reference,
 * from each vector's own JSON inputs, as `replay.ts` answers the others (and
 * with its conventions). They come after every other group in the file.
 */
import { importVerifyingKeys, licenseFileToken, verifyLease, verifyLicenseFile } from '@keygrant/shared'
import { checkLease, trialLeaseValid } from '../src/offline.js'
import { checkLicenseFile, licenseFileStatus } from '../src/license-file.js'
import type { FileGroup, GroupInputs } from './inputs.js'
import { plain, verified, type Group } from './replay.js'

/** A vector's bytes: canonical base64url, as `vectors/files.ts` writes them. */
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'))

export const FILES: { [G in FileGroup]: Group<GroupInputs[G]> } = {
  licenseFileContainers: {
    outputs: ['expect'],
    answer: (i) => ({ expect: licenseFileToken(bytesOf(i.bytes)) }),
  },
  licenseFiles: {
    outputs: ['verify', 'expect', 'status'],
    async answer(i) {
      const v = await verifyLicenseFile(i.token, await importVerifyingKeys(i.keys))
      const check = checkLicenseFile(v, i.product, i.major, i.revoked)
      return {
        verify: plain(v),
        expect: check.ok ? { ok: true, kind: check.kind, test: check.test } : { ok: false, reason: check.reason },
        status: plain(licenseFileStatus(check)),
      }
    },
  },
  filesAsLeases: {
    outputs: ['verify', 'expect', 'trial'],
    async answer(i, key) {
      const v = await verifyLease(i.token, key, i.now)
      const check = checkLease(v, i.product, i.major, i.holder)
      return {
        verify: verified(v),
        expect: check.ok ? { ok: true, test: check.test } : { ok: false, reason: check.reason },
        trial: trialLeaseValid(v, i.product, i.holder),
      }
    },
  },
}

