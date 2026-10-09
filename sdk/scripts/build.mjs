/**
 * Build `@keygrant/electron` for publishing: what an app installs from npm.
 *
 * In this repo the SDK is consumed as TypeScript source with `@keygrant/shared`
 * as a workspace package, and neither of those exists for an app that installs
 * it. So the published package is BUILT: the lease format from `shared` is
 * bundled in (it is never published on its own), `zod` stays a dependency, and
 * the Node built-ins stay imports.
 *
 *   dist/index.js       ESM
 *   dist/index.cjs      CommonJS, for an Electron main process built as CJS
 *   dist/types/...      declarations, `@keygrant/shared` rewritten to its own copy
 *   dist/types-cjs/...  the same declarations, read as CommonJS, for `require`
 *
 * `pnpm --filter @keygrant/electron run build`, then `pnpm pack` / `pnpm publish`
 * (pnpm, not npm: `publishConfig` points the package at `dist`, and only pnpm
 * applies it to `main`, `types` and `exports`).
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

rmSync(dist, { recursive: true, force: true })

const common = {
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  // Installed beside it from npm; everything of ours, `shared` included, is inside.
  external: Object.keys(pkg.dependencies ?? {}),
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
}
await build({ ...common, format: 'esm', outfile: join(dist, 'index.js') })
await build({ ...common, format: 'cjs', outfile: join(dist, 'index.cjs') })

// Declarations for the SDK and the lease format it re-uses, then every
// `@keygrant/shared` in the SDK's declarations pointed at the copy beside them.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const sharedIndex = join(dist, 'types', 'shared', 'src', 'index.js')
for (const file of walk(join(dist, 'types', 'sdk'))) {
  if (!file.endsWith('.d.ts')) continue
  const text = readFileSync(file, 'utf8')
  let target = relative(dirname(file), sharedIndex).split(sep).join('/')
  if (!target.startsWith('.')) target = `./${target}`
  const rewritten = text.replace(/(['"])@keygrant\/shared\1/g, `'${target}'`)
  if (rewritten !== text) writeFileSync(file, rewritten)
}

// The lease code is written against WebCrypto's global `JsonWebKey` and
// `CryptoKey`, which an app's TypeScript has only with the DOM lib. Named from
// Node's own WebCrypto types instead, so an Electron main process with
// `types: ["node"]` alone type-checks against them.
const WEBCRYPTO_TYPES = ['JsonWebKey', 'CryptoKey']
for (const file of walk(join(dist, 'types'))) {
  if (!file.endsWith('.d.ts')) continue
  const text = readFileSync(file, 'utf8')
  const used = WEBCRYPTO_TYPES.filter((name) => new RegExp(`\\b${name}\\b`).test(text))
  if (used.length === 0) continue
  const aliases = used.map((name) => `type ${name} = import('node:crypto').webcrypto.${name};`)
  writeFileSync(file, `${aliases.join('\n')}\n${text}`)
}

const left = walk(join(dist, 'types')).filter((f) => readFileSync(f, 'utf8').includes('@keygrant/shared'))
if (left.length > 0) throw new Error(`declarations still name @keygrant/shared: ${left.join(', ')}`)

// TypeScript reads a declaration file as ESM or CommonJS by the nearest
// package.json, and this package is `"type": "module"`, so the tree above is ESM
// to it. An app compiled as CommonJS (`module: node16` without `"type":
// "module"`) that requires the package then fails with TS1479, although
// `index.cjs` is a good CommonJS module. So the `require` condition gets the
// same declarations under a folder whose package.json says CommonJS.
cpSync(join(dist, 'types'), join(dist, 'types-cjs'), { recursive: true })
writeFileSync(join(dist, 'types-cjs', 'package.json'), '{ "type": "commonjs" }\n')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
