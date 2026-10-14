# Changelog

## 0.6.0

- Licence files: `importLicenseFile(content)` takes a `.kglicense` file's content (text or bytes, never
  a path) and verifies it offline. A key file activates its key, as `activate(key)` would. An offline
  licence file is stored and licenses the app with no network, ever: `status()` answers it with
  `source: 'file'` and `licensedTo`, before any key or trial, and `refresh()` asks nothing for it.
  `removeLicenseFile()` drops it; `deactivate()` leaves it.
- `revokedLicenseFiles` in the configuration lists the ids of files this build refuses: a stored one
  reads as `invalid` with the new reason `revoked-file`. An app that switches over every `LicenseReason`
  with an exhaustiveness check has one more case to handle.
- `LICENSE_FILE_EXTENSION` (`.kglicense`) for an open dialog's filter, and the types
  `ImportLicenseFileResult`, `LicenseFileError`, `LicenseFileKind` and `LicensedTo`.
- `StoredState` has `licenseFile`, the stored offline file's token.

## 0.5.0

- `purchaseUrl` is removed, and the SDK no longer asks for a bought key at `status()`, `refresh()` or
  `startTrial()`. To sell from the app, open your Payment Link from your own Buy button; the customer types
  the key from the delivery email (`activate`). A purchase secret an earlier version stored is ignored, and
  left out the next time the SDK saves its state.
- `StoredState` no longer has `purchaseToken`, `purchaseTokenAt` or `claimAskedAt`: a storage adapter or test
  code that sets them stops compiling, and whatever it sets is left out of the next save.

## 0.4.0

- Key sets: `publicJwks` takes the product's public keys (the `keys` of `/pubkey`: the key that signs its
  leases, and the next one once staged). A lease naming its key (`kid`) is verified by that key, one naming
  none by each key in turn. `publicJwk` alone is a key set of one, so an app configured before keeps
  working; giving both, or neither, throws.
- A lease signed by a key the build does not carry is `invalid` with the new reason `unknown-key`, rather
  than `tampered`.
- Each activation, validate and claim sends the ids of the keys the build carries (`kids`).
- `license.has(code)` and `license.require(code)` answer, offline from the stored lease, whether the licence
  grants an entitlement; `require` rejects with `MissingEntitlementError`. `grants(entitlements, code)`
  answers it of a status's entitlements.
- Each public key is checked when the license is made, and one that is not an Ed25519 public JWK throws
  there rather than at the first check: `kty` "OKP" and `crv` "Ed25519", no `d`, `use` (when given) "sig",
  `key_ops` (when given) naming "verify", `alg` (when given) "EdDSA" or "Ed25519". An `x` pasted with its
  base64 padding is read as the same key.
