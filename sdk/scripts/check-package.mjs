/**
 * Check the packed `@keygrant/electron` the way apps consume it, before it is
 * published: `pnpm pack` (which builds, `prepack`), then the tarball unpacked
 * into throwaway apps that type-check against it and load it, one per way an
 * app is built:
 *
 *   CommonJS, `module: node16`     an Electron main process compiled by tsc
 *   ESM, `module: node16`          the same, as an ES module
 *   `moduleResolution: bundler`    electron-vite, webpack, esbuild
 *   `moduleResolution: node10`     an older tsconfig, which ignores `exports`
 *
 * then `require` and `import` of it at runtime. They break separately: the
 * CommonJS app fails with TS1479, while the other three pass, when every
 * condition shares one declaration tree, which TypeScript reads as ESM.
 *
 * Each app is DOM-less (`lib: ["es2022"]`, `types: ["node"]`), as an Electron
 * main process is: the declarations name WebCrypto's `JsonWebKey` and
 * `CryptoKey`, which only the DOM lib has, so the build aliases them to
 * `node:crypto`'s (build.mjs), and only a DOM-less app shows when it does not.
 *
 * `pnpm --filter @keygrant/electron run check:package`, and `prepublishOnly`
 * runs it, so a package that fails it is never published. `--tarball <file>`
 * checks a tarball already packed instead (the release pipeline's: the very
 * file it then publishes). It needs no network:
 * the dependencies the PACKED manifest names are linked from this workspace
 * (so one the manifest dropped is missing here too), and `@types/node`.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const tsc = require.resolve('typescript/bin/tsc')
const work = mkdtempSync(join(tmpdir(), 'keygrant-package-'))

// One app that uses the public surface: a constructor, a method, and types,
// the entitlements a status carries and a licence file's kind included (the
// lease format's own types, which the declarations take from the bundled copy
// of shared).
const APP = `import {
  License,
  LICENSE_FILE_EXTENSION,
  type Entitlement,
  type Entitlements,
  type ImportLicenseFileResult,
  type LicensedTo,
  type LicenseFileError,
  type LicenseFileKind,
  type LicenseStatus,
} from '@keygrant/electron'

const license = new License({
  product: 'my-product',
  apiBaseUrl: 'https://api.keygrant.dev',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
  major: 1,
  revokedLicenseFiles: ['lf_1'],
})

export const extension: string = LICENSE_FILE_EXTENSION

export async function importFile(bytes: Uint8Array): Promise<[LicenseFileKind, LicensedTo] | string> {
  const result: ImportLicenseFileResult = await license.importLicenseFile(bytes)
  return result.ok ? [result.kind, result.licensedTo] : result.error
}

export async function removeFile(): Promise<void> {
  await license.removeLicenseFile()
}

export const refused: LicenseFileError = 'revoked-file'

export async function state(): Promise<LicenseStatus['state']> {
  return (await license.status()).state
}

export async function edition(): Promise<string | undefined> {
  const granted: Entitlements | undefined = (await license.status()).entitlements
  const value: Entitlement | undefined = granted?.edition
  return typeof value === 'string' ? value : undefined
}
`

const APPS = [
  { name: 'commonjs-node16', type: 'commonjs', module: 'node16', moduleResolution: 'node16' },
  { name: 'esm-node16', type: 'module', module: 'node16', moduleResolution: 'node16' },
  { name: 'bundler', type: 'module', module: 'esnext', moduleResolution: 'bundler' },
  { name: 'commonjs-node10', type: 'commonjs', module: 'commonjs', moduleResolution: 'node10' },
]

const failures = []
try {
  const given = process.argv.indexOf('--tarball')
  const tarball = given >= 0 ? resolve(process.argv[given + 1]) : pack()
  for (const app of APPS) typeCheck(app, tarball)
  loadAtRuntime()
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`The packed @keygrant/electron fails ${failures.length} check(s):\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log(`The packed @keygrant/electron passes: ${APPS.map((a) => a.name).join(', ')}, require and import.`)

/** One kind of app, with the tarball installed, type-checked against it; a failure noted in `failures`. */
function typeCheck(app, tarball) {
  const dir = join(work, app.name)
  install(tarball, dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: app.name, private: true, type: app.type }))
  writeFileSync(join(dir, 'index.ts'), APP)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: app.module,
        moduleResolution: app.moduleResolution,
        target: 'es2022',
        lib: ['es2022'],
        strict: true,
        noEmit: true,
        types: ['node'],
        // node10 is deprecated in TypeScript 5.x; apps still ship with it.
        ...(app.moduleResolution === 'node10' ? { ignoreDeprecations: '5.0' } : {}),
      },
      files: ['index.ts'],
    }),
  )
  const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' })
  if (result.status !== 0) failures.push(`${app.name}: tsc\n${result.stdout}${result.stderr}`)
}

/** The CommonJS and ESM apps' installs loaded with `require` and `import`; a failure noted in `failures`. */
function loadAtRuntime() {
  const loads = [
    ['commonjs-node16', ['-e', "if (typeof require('@keygrant/electron').License !== 'function') process.exit(1)"]],
    [
      'esm-node16',
      [
        '--input-type=module',
        '-e',
        "const k = await import('@keygrant/electron'); if (typeof k.License !== 'function') process.exit(1)",
      ],
    ],
  ]
  for (const [app, args] of loads) {
    const result = spawnSync(process.execPath, args, { cwd: join(work, app), encoding: 'utf8' })
    if (result.status !== 0) failures.push(`${app}: loading at runtime\n${result.stdout}${result.stderr}`)
  }
}

/** `pnpm pack` into the work folder; the tarball's path. */
function pack() {
  const out = join(work, 'pack')
  mkdirSync(out)
  // Through pnpm itself when it is running this (it applies `publishConfig`, which npm
  // does not). Otherwise through the shell, which is how `pnpm` is found on Windows (a
  // .cmd), with the folder quoted: a profile path can hold a space. Its own output is kept
  // and shown when it fails: `prepack` builds, and a build error is the likely failure.
  const pnpm = process.env.npm_execpath
  const ran =
    pnpm && /pnpm/i.test(pnpm)
      ? spawnSync(process.execPath, [pnpm, 'pack', '--pack-destination', out], { cwd: root, encoding: 'utf8' })
      : spawnSync(`pnpm pack --pack-destination "${out}"`, { cwd: root, encoding: 'utf8', shell: true })
  if (ran.status !== 0) throw new Error(`pnpm pack failed:
${ran.stdout ?? ''}${ran.stderr ?? ''}${ran.error ?? ''}`)
  const [file] = readdirSync(out).filter((f) => f.endsWith('.tgz'))
  if (!file) throw new Error('pnpm pack wrote no tarball')
  return join(out, file)
}

/**
 * The tarball unpacked as `node_modules/@keygrant/electron`, with the dependencies ITS
 * manifest names linked from this workspace, and `@types/node` for the app's own types.
 */
function install(tarball, dir) {
  const modules = join(dir, 'node_modules')
  const pkgDir = join(modules, '@keygrant', 'electron')
  untar(gunzipSync(readFileSync(tarball)), pkgDir)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  for (const dep of [...Object.keys(manifest.dependencies ?? {}), '@types/node']) {
    const target = dirname(require.resolve(`${dep}/package.json`))
    mkdirSync(dirname(join(modules, dep)), { recursive: true })
    // A junction on Windows, which needs no administrator; a plain symlink elsewhere.
    symlinkSync(target, join(modules, dep), 'junction')
  }
}

/** The regular files of a tar archive written under `dest`, the leading `package/` stripped. */
function untar(archive, dest) {
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(text(124, 136).trim() || '0', 8)
    const type = text(156, 157) || '0'
    const prefix = text(345, 500)
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)
    if (type === '0') {
      const path = join(dest, name.replace(/^package\//, ''))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, archive.subarray(at + 512, at + 512 + size))
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
}
