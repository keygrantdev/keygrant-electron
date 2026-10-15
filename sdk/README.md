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
it. Embed the whole set each time you build. Each activation and validate
reports the ids of the keys the build carries (`kids`), so the dashboard
can count the devices still on builds without the staged key before you
switch.

The full guide (configuration, statuses, where the state is kept, trials,
versions, device hold, test licences) is at https://keygrant.dev/docs.

## Buying from the app

Give a customer who holds no key a Buy button that opens your Stripe Payment
Link. The checkout emails them their key, and they type it into the app:

```ts
import { shell } from 'electron'

await shell.openExternal('https://buy.stripe.com/your-link')
// Once they have the key from the email:
const result = await license.activate(enteredKey)
```

For a customer who already holds a key, `upgradeUrl(link)` adds this install's
activation to the link, so an upgrade sale finds the key it upgrades.

## Keys only their buyer can activate

A licence model can be **user-locked**: a NEW device activates on a key only when
the person types the address the key was sold to, and, if the model says so,
the code mailed to that address. Only a new device is asked: `status()`,
renewals and a device that already holds a seat never are, and a key that is not
locked ignores both fields (an address over 254 characters, or a code that is not
six digits, is refused by the SDK itself for any key, without asking).

```ts
let result = await license.activate(key)
if (!result.ok && result.error === 'user-email-required') {
  // Ask the person for the email they bought with.
  result = await license.activate(key, { email })
}
if (!result.ok && result.error === 'user-code-required') {
  // A code was just mailed to that address: ask for it.
  result = await license.activate(key, { email, code })
}
```

The other answers an app should word: `user-email-mismatch` (not the key's
address; nothing is said of the real one), `user-code-invalid` (wrong, expired or
used: ask again, or `activate(key, { email })` for a new code), `too-many-codes`
(three codes an hour), `too-many-attempts` (too many wrong tries; wait), and
`try-again` (the code could not be sent just now: nothing was activated, ask
again). Neither the address nor the code is stored by the SDK. A key file
(`importLicenseFile`) of a locked key takes the same `{ email, code }`.

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

## Licence files: drag and drop

A licence can come as a file (`.kglicense`) the customer drops onto the app or
opens from its licence screen. A **key file** carries their key: importing it
activates the key online, exactly as typing it would. An **offline licence
file** licenses the app with no network at all, for good, on machines that
never connect; it has no seat limit and cannot be revoked, so the only way to
stop one that leaked is an app update that lists its id:

```ts
// main process
import { app, dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { License, LICENSE_FILE_EXTENSION } from '@keygrant/electron'

const license = new License({
  product: 'sluice',
  apiBaseUrl: 'https://api.keygrant.dev',
  publicJwks: KEYS.keys,
  major: 3,
  revokedLicenseFiles: [], // ids of files that leaked: an update adds them here
})

// The renderer hands over a dropped file's bytes.
ipcMain.handle('license:import', (_event, bytes: Uint8Array) => license.importLicenseFile(bytes))

// "Open licence file..." in a menu.
async function openLicenseFile() {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'License file', extensions: [LICENSE_FILE_EXTENSION.slice(1)] }],
  })
  if (filePaths[0]) return license.importLicenseFile(await readFile(filePaths[0]))
}

// macOS: a .kglicense the app is registered for, double-clicked in Finder.
app.on('open-file', async (event, path) => {
  event.preventDefault()
  try {
    const result = await license.importLicenseFile(await readFile(path))
    if (!result.ok) showError(result.error)
  } catch (error) {
    showError(error) // unreadable, not saved, or a licence call still running: try again
  }
})
```

```ts
// preload
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('licensing', {
  importFile: (bytes: Uint8Array) => ipcRenderer.invoke('license:import', bytes),
})

// renderer
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', async (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (!file) return
  const result = await window.licensing.importFile(new Uint8Array(await file.arrayBuffer()))
  if (result.ok) showThanks(result.licensedTo.name ?? result.licensedTo.email)
  else showError(result.error)
})
```

`importLicenseFile` takes the file's content (text, a byte array, a Node
`Buffer` or an `ArrayBuffer`), never its path, and verifies it offline: signed
by a key of `publicJwks`, for this product, and, for an offline file, covering
this build's major. It resolves `{ ok: true, kind: 'key' | 'offline',
licensedTo }`, or `{ ok: false, error }` with one of `malformed`,
`not-a-license-file`, `bad-signature`, `unknown-key`, `wrong-product`,
`revoked-file`, `upgrade`, `outdated`, or for a key file whatever `activate()`
answers. It rejects when a licence call before it has not finished, when an
offline file cannot be saved, and, for a key file, wherever `activate()`
rejects. `unknown-key` means the file was signed by a key this build does not
carry: a newer one, after the product rotated its key, which an update of the
app carries. A key file's notes print its key, which can be typed meanwhile.

An offline file is kept and checked again on every `status()`, which then
answers `{ state: 'licensed', source: 'file', key, licensedTo, ... }` with the
file's entitlements, never asking the server, `refresh()` included. Show
"Licensed to Ada Lovelace" from `licensedTo`. A status with `source: 'file'`
has no seat to deactivate: offer `removeLicenseFile()` instead. If the device
also holds a key, a file that covers this build wins, and the key keeps working
once the file is removed, revoked or outgrown. A file that does not cover this
build answers only when no key and no running trial does.

**Keep every key that signed a file in your builds.** A file names the key that
signed it and never expires, so a key that has signed one stays in the
product's key set, and in `publicJwks`, after it stops signing leases. A build
without it reads such a file as `invalid` / `unknown-key`.

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
