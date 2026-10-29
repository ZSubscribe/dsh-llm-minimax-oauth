/**
 * Verifies the produced `lib/client.js` satisfies the DSH client-modules
 * contract (C6 in `packages/client/modules/src/client/system.ts`):
 *
 *   1. The artifact is wrapped in `window.__ModuleLoader__.load({ id, factory })`
 *      so the host shell kernel can register the factory before cordis exists.
 *   2. The factory body is a CJS module whose `require()` calls reach the
 *      loader module table for declared externals (`react`, `react/jsx-runtime`).
 *   3. The factory returns `module.exports`, which carries the function
 *      plugin's `name` and `apply` so the host can compose it as a cordis
 *      plugin without a second import step.
 *
 * The test does NOT depend on the host runtime or any OAuth credential: it
 * reads the built file and inspects the static wrapper, which is what
 * `clientExportOf` (in `packages/client/modules/src/index.ts`) does at
 * activation time when reading the artifact path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const clientArtifact = resolve(pluginRoot, 'lib/client.js')

test('build artifact: lib/client.js exists at the path package.json exports["./client"] resolves to', () => {
  assert.ok(existsSync(clientArtifact), `client bundle missing at ${clientArtifact}`)
})

test('build artifact: lib/client.js wraps window.__ModuleLoader__.load with the package id', () => {
  const source = readFileSync(clientArtifact, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id:\s*["']dsh-llm-minimax-oauth["']/)
  assert.match(source, /factory:\s*\(require\)\s*=>/)
})

test('build artifact: factory body is a CJS module that returns module.exports', () => {
  const source = readFileSync(clientArtifact, 'utf8')
  // The intro banner sets up `module.exports = {}`; match the exact emitted
  // shape (with the trailing semicolon tsdown emits).
  assert.ok(
    source.includes('var module = { exports: {} };'),
    'CJS module scaffold missing',
  )
  assert.ok(
    source.includes('return module.exports;'),
    'factory does not return module.exports',
  )
})

test('build artifact: declared client externals are kept as runtime require() calls', () => {
  const source = readFileSync(clientArtifact, 'utf8')
  // The bundle must NOT inline React; it must reach the loader module table.
  assert.match(source, /require\(["']react["']\)/, 'react was inlined; it must stay external')
  assert.match(
    source,
    /require\(["']react\/jsx-runtime["']\)/,
    'react/jsx-runtime was inlined; it must stay external',
  )
})

test('build artifact: function plugin surface (name + apply) is exposed on module.exports', () => {
  const source = readFileSync(clientArtifact, 'utf8')
  assert.match(source, /exports\.name\s*=\s*name/, 'plugin name not assigned to module.exports')
  assert.match(source, /exports\.apply\s*=\s*apply/, 'plugin apply not assigned to module.exports')
})

test('build artifact: no leftover default export (would force consumers to use chunk.default)', () => {
  const source = readFileSync(clientArtifact, 'utf8')
  assert.doesNotMatch(
    source,
    /exports\.default\s*=/,
    'a default export in the client bundle warns as MIXED_EXPORTS; UI plugins must use named exports only',
  )
})

test('build artifact: node-half bundle still emits lib/index.mjs for the runtime', () => {
  const nodeArtifact = resolve(pluginRoot, 'lib/index.mjs')
  assert.ok(existsSync(nodeArtifact), `node bundle missing at ${nodeArtifact}`)
})

test('build artifact: client bundle declares slots in inject (cordis property proxy requirement)', () => {
  // Without `slots` in the runtime `inject` array, the cordis ReflectService
  // throws `cannot get property "slots" without inject` when `apply(ctx)`
  // touches `ctx.slots`. Every DSH UI plugin (slot-catalog examples,
  // ui-settings-general, ui-directory-picker-browse, ...) declares it.
  const source = readFileSync(clientArtifact, 'utf8')
  assert.match(
    source,
    /const\s+inject\s*=\s*\[\s*["']slots["']\s*\]/,
    'client bundle must declare inject: ["slots"] so ctx.slots resolves through the Reflect proxy',
  )
  assert.match(
    source,
    /exports\.inject\s*=\s*inject/,
    'plugin name/inject/apply must be on module.exports so the host loader can compose them',
  )
  // apply must defer through slots.inject: `settings.section` is declared by
  // ui-settings-general, and activation order is not guaranteed. A direct
  // register can run before the declaration and throws
  // `slot "settings.section" is not declared`, which failed this plugin's
  // client fiber and aborted web boot ("web boot: 1 entry did not activate").
  assert.match(
    source,
    /return\s+clientCtx\.slots\.inject\(\s*["']settings\.section["']/,
    'apply must register the settings section through slots.inject (slot is declared by ui-settings-general)',
  )
  assert.match(
    source,
    /clientCtx\.slots\.register\(/,
    'the deferred callback must still register the MiniMax OAuth settings section',
  )
})
