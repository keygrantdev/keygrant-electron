/**
 * The licence-file machinery under `License` (license.ts): taking a file an
 * app was handed (`importFile`), the status a stored offline file gives
 * (`fileStatus`), and removing it (`removeFile`). Never online: a key file's
 * key is activated by `License`, as a typed key is.
 */
import { licenseFileToken, verifyLicenseFile } from '@keygrant/shared'
import type { ActivateResult, ImportLicenseFileResult, LicenseConfig, LicenseStatus, StoredState } from './types.js'
import { TrialEngine } from './trials.js'
import { checkLicenseFile, licenseFileStatus, licensedToOf, type LicenseFileCheck } from './license-file.js'

export abstract class FileEngine extends TrialEngine {
  /** The ids of licence files this build refuses (`LicenseConfig.revokedLicenseFiles`). */
  private readonly revokedFiles: readonly string[]

  constructor(config: LicenseConfig) {
    super(config)
    this.revokedFiles = revokedOf(config.revokedLicenseFiles)
  }

  /** A licence file's token verified against the build's key set and judged for this app (license-file.ts `checkLicenseFile`). */
  private async checkFile(token: unknown): Promise<LicenseFileCheck> {
    return checkLicenseFile(await verifyLicenseFile(token, await this.keySet()), this.product, this.major, this.revokedFiles)
  }

  /**
   * The status the stored offline licence file gives, verified again now
   * (license-file.ts `licenseFileStatus`), or null when none is stored. A
   * stored value that is not text (a state another program wrote) is no token:
   * `invalid` / `tampered`, never a rejection.
   */
  protected async fileStatus(state: StoredState): Promise<LicenseStatus | null> {
    const stored: unknown = state.licenseFile
    return stored === undefined || stored === null ? null : licenseFileStatus(await this.checkFile(stored))
  }

  /**
   * Take a licence file: its token read from the content (shared
   * `licenseFileToken`), verified and judged for this app. An offline file is
   * stored, replacing any stored before; a key file's key is handed to
   * `activate`, and its answer is the import's. Nothing is stored for a file
   * refused. Rejects when the offline file cannot be saved, and wherever
   * `activate` rejects for a key file.
   */
  protected async importFile(
    content: string | Uint8Array | ArrayBuffer,
    activate: (key: string) => Promise<ActivateResult>,
  ): Promise<ImportLicenseFileResult> {
    const token = licenseFileToken(content)
    if (token === null) return { ok: false, error: 'malformed' }
    const check = await this.checkFile(token)
    if (!check.ok) return { ok: false, error: check.reason }
    const licensedTo = licensedToOf(check.claims)
    if (check.kind === 'key') {
      const activated = await activate(check.claims.sub)
      return activated.ok ? { ok: true, kind: 'key', licensedTo } : activated
    }
    // Unbased: it is about no activation, so it lands as it is on whatever is stored.
    await this.save({ licenseFile: token })
    return { ok: true, kind: 'offline', licensedTo }
  }

  /** Drop the stored offline licence file, if any. Rejects when that cannot be saved. */
  protected async removeFile(): Promise<void> {
    await this.save({ licenseFile: undefined })
  }
}

/**
 * The denylist a configuration gives: none when absent, else a list of
 * texts, each a file id. Anything else is a configuration that would revoke
 * nothing it was meant to, and throws when the License is made.
 */
function revokedOf(revoked: unknown): readonly string[] {
  if (revoked === undefined) return []
  if (!Array.isArray(revoked) || !revoked.every((id) => typeof id === 'string')) {
    throw new Error('KeyGrant: revokedLicenseFiles is a list of licence file ids (texts)')
  }
  return [...revoked]
}
