# Changelog

## 0.9.0

- Key pickup, for a build that may not take a typed key (an App Store build): `pickUp(email)` asks KeyGrant
  to mail a code to the address, answered `{ ok: true, sent: true }` whether or not the address holds a key;
  `pickUp(email, code)` answers that address's live keys of the product (`PickedKey`: its model, what it
  grants, its versions, its seats, whether this device already holds one); `restoreByEmail(email, code)`
  confirms and activates the key that fits this build (the one this device holds, else one with a free seat,
  else the first), never handing the key to the app. A user-locked key activates with the address, and a
  code-locked one with the code the pickup proved, so nothing more is asked. Errors: `invalid-email`,
  `wrong-code`, `code-expired`, `too-many-attempts` (with `retryAfter`), `pickup-disabled`, `try-again`,
  `network`, and from a restore `no-key`, `upgrade` and `outdated`, then `activate()`'s own. The product's
  Key pickup must be on. Nothing about a pickup is stored. The new types `PickedKey`, `PickupError`,
  `PickUpSentResult`, `PickUpKeysResult` and `RestoreResult` are exported.

## 0.8.0

- Metered uses: `use(meter, n = 1)` spends `n` uses of a meter the key's licence model counts (1,000
  exports for good, 50 renders each billing period) and answers `{ ok: true, left }`, or `{ ok: false,
  error }` with `invalid-amount`, `no-meter`, `used-up` (with `left`), `offline-limit` (with `left`),
  `not-licensed`, `storage`, or the server's verdict on the key, the build or the device (`revoked`,
  `upgrade`, `outdated`, `device`). Online it is exact and atomic. When KeyGrant gives no answer (no
  network, a timeout, a 5xx, a 429) the device spends from its offline allowance for the meter, never past
  what it last heard is left, and answers `{ ok: true, left, offline: true }`; past the allowance it is
  `offline-limit`. A spend the allowance would refuse asks the server, whatever the last outage left
  behind, once a minute while it stays out of reach; one it covers waits a minute after an outage, doubling to an
  hour. It never rejects, and its request waits at most 5 seconds (less when `httpTimeoutMs` is
  shorter). A meter never takes a licence away: nothing in `status()` reads one to decide whether the app is
  licensed.
- `status().meters`, by meter code: `left` (the lease's figure net of this device's unsynced spends), `total`,
  `offline` (this device's allowance), `unsynced` and `resets`. Offline, from the lease; on a `licensed`
  status from a key's lease that names meters only. The new types `MeterStatus`, `UseResult` and `UseError`
  are exported.
- The spends a device made with no answer are kept in the stored state (`spends`, with the newest figures a
  `use` answer gave in `meterFigures`), merged across processes as the rest of the state is, and reported
  with the next `validate` (a check-in or renewal), `use` or `deactivate`, which now also names the device's
  fingerprints when it carries a report. They are dropped only when the server says it recorded them; a
  device back online reports at its next `status()`. A journal never fails a renewal or a deactivation. Entries
  not reported within 180 days are dropped, and at most 64 are kept. A spend the SDK could not save (a disk
  that refuses its writes) is kept in memory, counted in `left` and `unsynced`, and reported once it has
  been saved (a spend whose request got no answer, and the take-back of one that was refused, are reported
  with the next request). `deactivate()` clears them with the licence even when KeyGrant could not be
  reached, so what the server did not hear is lost: at most the offline allowance of each meter.
- `StoredState` has `spends` and `meterFigures`, and `SpendEntry` and `MeterFigure` are exported. An app that
  switches over every `LicenseError` is unaffected: `use` has its own errors.

## 0.7.0

- User-locked keys: `activate(key, { email, code })` and `importLicenseFile(content, { email, code })`.
  A licence model can let only the person a key was sold to activate a new device on it, known by the
  address on the key (`email`), and, for a key that mails a code to that address, by the code too.
  The new refusals come back as typed errors an app can act on: `user-email-required` (ask for the
  address), `user-email-mismatch`, `user-code-required` (a code was just mailed: ask for it),
  `user-code-invalid`, `too-many-codes`, `too-many-attempts`, and `try-again` (the code could not be sent:
  nothing was activated, ask again). An app that switches over every `LicenseError` with an
  exhaustiveness check has seven more cases to handle. Only a NEW device is ever asked: `validate`,
  `status()`, renewals, a seat the key already holds and offline behaviour are unchanged, and a key that is
  not locked ignores both options (an address over 254 UTF-16 units, or a code that is not six digits, is
  refused by the SDK itself for any key). Nothing about the address or the code is stored.
- `ActivateOptions` is exported.

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
