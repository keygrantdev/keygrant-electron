# @keygrant/electron

KeyGrant licensing for Electron and Node desktop apps. A licence is a signed
lease the app verifies offline; the SDK only goes online to activate, to renew a
lease near its end, or to tell the server of a newer major, and an outage never
takes a licence away from a paying customer.

```bash
npm install @keygrant/electron
```

Node 20 or later; ESM and CommonJS, with types for both.

```ts
import { License } from '@keygrant/electron'
import KEYS from './keygrant-keys.json' // {"keys":[...]}

const license = new License({
  product: 'sluice',
  apiBaseUrl: 'https://api.keygrant.dev',
  publicJwks: KEYS.keys,
  major: 1,
})

const { state } = await license.status() // 'licensed' | 'trial' | 'expired' | 'invalid' | 'unlicensed' | 'unknown'
const result = await license.activate(key)
```

`major` is the app's major version, read as KeyGrant's server reads a version:
a 0.x build (`major: 0`) is major 1, and leaving it out is 1 as well.

`keygrant-keys.json` is the product's key set: `GET
https://api.keygrant.dev/v1/products/<slug>/pubkey` (public, no API key) answers
it as `keys`, and the dashboard's Signing key tab copies it (Copy key set).
Fetch it when you build and ship it with the app. `publicJwk`, one key, still
works: a set of one.

**Why a set.** A lease names the key that signed it (`kid` in its header, the
key's RFC 7638 thumbprint, which the SDK computes from the key itself). It is
verified by that key; a lease that names none (every lease signed before key
sets) by each key in turn; and one naming a key the build does not carry is
refused: `status()` says `invalid` with reason `unknown-key` once the lease
the device holds is one. When the product rotates its signing key, it first
*stages* the next key, published beside the current one while every lease is
still signed with the current key. Ship builds carrying both; once they are
out, the product *switches*, and those builds verify every lease signed after
it. Embed the whole set each time you build. Each activation, validate and
claim reports the ids of the keys the build carries (`kids`), so the dashboard
can count the devices still on builds without the staged key before you
switch.

The full guide (configuration, statuses, where the state is kept, trials,
versions, device hold, test licences) is at https://keygrant.dev/docs.

## Buying from the app: no key to type

Give a customer who holds no key a Buy button that opens your Stripe Payment
Link through `purchaseUrl`. When they come back to the app, the key they bought
is picked up and this device activated on it, with nothing typed:

```ts
import { shell } from 'electron'

let checkoutOpened = false
const url = await license.purchaseUrl('https://buy.stripe.com/your-link')
if (url) {
  await shell.openExternal(url) // url is null while a key is held: use upgradeUrl() for an upgrade
  checkoutOpened = true
}

// When the customer is back (the window regains focus, say), and only while a
// checkout is open: refresh() on a licensed install validates online every time.
if (checkoutOpened && (await license.status()).state !== 'licensed') {
  const status = await license.refresh() // 'licensed' once the checkout has gone through
  if (status.state === 'licensed') checkoutOpened = false
}
```

- **How:** `purchaseUrl` keeps a one-time secret for this install (random,
  never the device's fingerprint) and sets the link's `client_reference_id` to
  a hash of it, so a link that leaks (browser history, a screenshot) claims
  nothing. The checkout keeps that reference on the key it mints, and the SDK
  asks for the key with the secret: at once on `refresh()` or `startTrial()`,
  and from `status()` at most every five minutes for a day after the link
  (after that, `refresh()` or `startTrial()` still ask). Until the key is
  bought, the status is what it was (the trial, or unlicensed).
- **Calling it again** hands out the same secret's link, so the key bought
  through either link is picked up (paying twice buys two keys; the second
  comes by email). A secret is dropped 30 days after the last link, once its
  key is picked up, or when the product's "Converts in place" switch is off
  (the customer then types the key from the delivery email).
- **It rejects** when the link is not an absolute URL, or when the secret cannot
  be saved (a link whose secret is lost could never be picked up).
- **Turn the product's "Converts in place" switch on** once your app uses
  `purchaseUrl`: it is off by default, and until it is on every pickup is
  refused and the customer types the key from the delivery email. Know the
  trade before you do: whoever opens a checkout owns its pickup. Your Payment
  Link is public, so anyone can add a `client_reference_id` of their own to it
  and get buyers to pay through their copy of the link; the key bought that
  way is picked up by the link's maker, not the buyer. A link from the app is
  the buyer's own; a leaked one claims nothing, as it carries only a hash of
  the app's secret. A planted pickup shows in the key's history, and you can
  free the seat for the buyer.

## Trials: what the app calls

```ts
const status = await license.status()
if (status.state === 'unlicensed') await license.startTrial() // begins the trial, once
```

A running trial reports its launch to KeyGrant by itself: `status()` sends it
at most once a day, in the background, answering without waiting for the
request and never failing offline (it saves the day's stamp first), so the
dashboard's trial funnel sees the trial come back. The
app does not need to call `startTrial()` on every launch for that.
`startTrial()` still re-syncs the trial when called: a change to the trial's
length or entitlements reaches a running trial there.

## Entitlements: telling editions apart offline

A licence can grant more than the base product: an edition, a number of seats,
an add-on. The lease signs them (its `ent` claim) and `status()` hands them to
the app as `entitlements`, read offline like everything else on the lease:

```ts
const status = await license.status()
const pro = status.entitlements?.edition === 'pro'
const seats = typeof status.entitlements?.seats === 'number' ? status.entitlements.seats : 1
```

- **Type:** `Readonly<Record<string, boolean | number | string>>` (exported as
  `Entitlements`). Frozen: change a copy, not the status. A plain object, so
  a name that is also an `Object.prototype` member (`constructor`,
  `toString`) reads that member when it is not granted: test such a name with
  `Object.hasOwn(status.entitlements ?? {}, name)`.
- **When it is there:** on a `licensed` status (from the licence's lease, after
  an activation, a renewal, a `refresh()` or straight from the device) and on a
  `trial` status (from the trial's lease), when that lease grants at least one.
- **When it is not:** on every other status (`expired`, `invalid` for any
  reason, `unlicensed`, `unknown`), and when the lease grants none: then the
  status has no `entitlements` field at all, so `?.` reads it either way.
- **A malformed claim never costs the licence:** members that are not a flag, a
  number or a text are left out, and an `ent` that is not an object at all
  reads as none. The SDK enforces none of the server's caps on them; the
  signature is what it trusts.

To ask whether the licence grants an entitlement, name its code:

```ts
if (await license.has('cloud_sync')) enableCloudSync()
await license.require('export') // rejects with MissingEntitlementError (its entitlement is 'export')
```

`has(code)` is true for a flag that is on, a number that is not zero, or a text
that is not empty; false for anything else, and for a code the lease does not
grant (matched exactly, case included, and only as the lease's own member, so
`constructor` is granted only when signed). It is answered offline from the
stored lease only, as `status()` would answer from what is stored, with no
request and no write: a licence that does not license this build, or none at
all, grants nothing; a running trial grants what its trial lease does.
`require(code)` rejects with `MissingEntitlementError`, naming the code, when
`has` would be false. `grants(status.entitlements, code)` answers the same of a
status already in hand.

## Building the package

The SDK is TypeScript source in a pnpm workspace. The installable package is
built:

```bash
pnpm --filter @keygrant/electron pack                # builds dist/, then keygrant-electron-<version>.tgz
pnpm --filter @keygrant/electron run check:package   # the tarball, type-checked and loaded as four kinds of app
```

`pack` builds first (`prepack`, the same as `run build`): ESM, CommonJS, the
lease format bundled in, and the types twice, once read as ESM and once as
CommonJS, so an app compiled either way type-checks. `check:package` packs,
unpacks the tarball into throwaway CommonJS (`node16`), ESM (`node16`),
bundler and `node10` apps, type-checks each against it, and loads it with
`require` and `import`; publishing runs it first (`prepublishOnly`).

Use pnpm, not npm: `publishConfig` points `main`, `types` and `exports` at
`dist`, and only pnpm applies it. Publish with
`pnpm --filter @keygrant/electron publish`, which runs `check:package` first and
stops on any failure.

## License

MIT. See `LICENSE`.
