export { License } from './license.js'
export { MissingEntitlementError, grants } from './entitlements.js'
export {
  DEFAULT_HTTP_TIMEOUT_MS,
  createFileStorage,
  defaultStoragePath,
  fetchHttp,
  hashFingerprint,
  hostnameFingerprint,
  nodeFingerprinter,
  noopRegistry,
  systemClock,
} from './adapters.js'
export type {
  ActivateResult,
  DeactivateResult,
  Adapters,
  Clock,
  DeviceIdentity,
  Fingerprinter,
  HttpAdapter,
  ImportLicenseFileResult,
  LicenseConfig,
  LicenseError,
  LicenseFileError,
  LicensedTo,
  LicenseReason,
  LicenseState,
  LicenseStatus,
  RegistryStash,
  StorageAdapter,
  StoredState,
} from './types.js'
export type { Entitlement, Entitlements, LicenseFileKind } from '@keygrant/shared'
export { LICENSE_FILE_EXTENSION } from '@keygrant/shared'
