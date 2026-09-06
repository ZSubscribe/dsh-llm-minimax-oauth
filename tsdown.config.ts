/**
 * Build configuration for the dsh-llm-minimax-oauth plugin.
 *
 * Two artifacts, one build:
 *
 *   1. Node half: `lib/index.mjs` (ESM) + `lib/index.d.mts` (types).
 *      Source: `src/index.ts`. Consumed by DSH runtime via package
 *      `exports["."]`; this is the adapter, OAuth flow, and `apply()`.
 *
 *   2. Client half: `lib/client.js` (CJS browser bundle, with
 *      `window.__ModuleLoader__.load({ id, factory })` wrapper).
 *      Source: `src/client/apply.ts`. Consumed by DSH client-modules via
 *      `package.json` `exports["./client"]` → `dsh.client` row in
 *      `__DSH_BOOT__` → served from `/plugins/<id>/client.js?rev=<hash>`.
 *
 * The contract `lib/client.js` must satisfy mirrors DSH's client-modules
 * pipeline (`packages/client/modules/src/index.ts:clientExportOf`):
 *   - File exists at the path `exports["./client"]` resolves to.
 *   - Format is CJS, target is browser.
 *   - File is wrapped so it can call `window.__ModuleLoader__.load(...)`
 *     when executed; the factory return is `module.exports`.
 *
 * @module dsh-llm-minimax-oauth/tsdown
 */
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-llm-minimax-oauth'

/** Specifiers the client bundle must keep as runtime externals (loader module table). */
const CLIENT_EXTERNALS = [
  // Platform baseline — frozen module table; do not inline.
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  // Plugin-specific declarations: mirrored to `dsh.client.external` in
  // package.json. Every entry here is a request to the loader module table,
  // not a candidate for inlining. Keep both lists in sync.
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** Node half — ESM bundle, consumed by `dsh` runtime. */
const nodeHalf = defineConfig({
  name: `${PLUGIN_ID}/node`,
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  clean: false,
})

/**
 * Client half — CJS browser bundle wrapped in `__ModuleLoader__.load()`.
 *
 * Mirrors `clientConfig()` in `packages/client/tsdown.client.ts` but
 * inlined here so the plugin can build without depending on the
 * repository's internal tsdown preset (the external workspace does not
 * see `packages/client/tsdown.client.ts`).
 */
const clientHalf = defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/apply.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string): boolean => {
      // Loader module table: specifiers declared as external must stay as
      // runtime imports. `node:` builtins are handled by rolldown itself.
      const externals: readonly string[] = CLIENT_EXTERNALS
      if (externals.includes(specifier)) return true
      // Every subpath of a declared external is also external: e.g.
      // `@deepseek-ai/cordis/lib/...` belongs to the module table too.
      for (const ext of externals) {
        if (specifier === ext || specifier.startsWith(`${ext}/`)) return true
      }
      return false
    },
    alwaysBundle: (specifier: string): boolean => {
      // Anything that is not a loader module-table row must inline —
      // requiring it at runtime would throw because the table cannot
      // answer for an undeclared specifier.
      const externals: readonly string[] = CLIENT_EXTERNALS
      if (specifier.startsWith('node:')) return false
      if (externals.includes(specifier)) return false
      for (const ext of externals) {
        if (specifier === ext || specifier.startsWith(`${ext}/`)) return false
      }
      return true
    },
  },
  outputOptions: {
    // The host parser preloads `/plugins/<id>/client.js`; the file must
    // sit exactly at `lib/client.js` (verified by `clientExportOf` in
    // `packages/client/modules/src/index.ts:148-159`).
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default defineConfig([
  nodeHalf,
  clientHalf,
])
