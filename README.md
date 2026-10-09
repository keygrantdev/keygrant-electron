# KeyGrant for Electron and Node

`@keygrant/electron` licenses Electron and Node desktop apps with [KeyGrant](https://keygrant.dev): signed
leases verified offline, activation, trials and renewals, failing in favour of the paying customer.

```sh
npm install @keygrant/electron
```

How to use it is in [sdk/README.md](sdk/README.md), and the full guide is at https://keygrant.dev/docs.

## Building from source

```sh
corepack enable
pnpm install
pnpm test
pnpm run typecheck
pnpm run check:package
```

- `sdk/` is the package.
- `shared/` is the lease format it bundles.
- `conformance/vectors.json` is the behaviour every KeyGrant SDK reproduces, and the tests check this one
  against it.

## Releases

Each release is a version tag (`0.3.0`). The tag runs `.github/workflows/publish.yml`, which tests and
builds the package and publishes it to npm through npm's trusted publishing, with provenance.

## License

MIT: see [LICENSE](LICENSE).
