# Changelog

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
