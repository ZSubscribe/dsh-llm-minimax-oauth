/**
 * Regression coverage for the DSH 0.2.1-rc.3 web-boot failure:
 *
 *   Error: web boot: 1 entry did not activate
 *   dsh-llm-minimax-oauth: failed
 *
 * The client half used to call `ctx.slots.register({ name: 'settings.section' })`
 * directly from `apply()`. `settings.section` is declared by
 * ui-settings-general (as a child of the `sidebar.settings` slot it owns),
 * and client activation order is not guaranteed — so when this plugin's
 * fiber ran first, `SlotRegistry.register` threw
 * `slot "settings.section" is not declared`, the fiber ended in `failed`
 * state, and the renderer aborted the whole boot.
 *
 * The fix registers through `ctx.slots.inject('settings.section', () =>
 * ctx.slots.register(...))`, which parks the contribution on the caller's
 * fiber until the slot is declared. These tests execute the built
 * `lib/client.js` factory with a fake slot service that throws exactly like
 * SlotRegistry on an undeclared slot, so the old eager `register` fails the
 * test while the inject form passes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const clientArtifact = resolve(pluginRoot, 'lib/client.js')

interface LoadedClientModule {
  id: string
  factory: (require: (id: string) => unknown) => {
    name?: string
    inject?: readonly string[]
    apply?: (ctx: unknown) => unknown
  }
}

interface SlotRegistration {
  options: {
    name: string
    id?: string
    order?: number
    label?: () => string
  }
  component: unknown
}

function loadClientBundle(): LoadedClientModule {
  const source = readFileSync(clientArtifact, 'utf8')
  let captured: LoadedClientModule | undefined
  const globals = globalThis as unknown as Record<string, unknown>
  const previousWindow = globals.window
  globals.window = {
    __ModuleLoader__: {
      load(spec: LoadedClientModule) {
        captured = spec
      },
    },
  }
  try {
    new Function(source)()
  } finally {
    if (previousWindow === undefined) delete globals.window
    else globals.window = previousWindow
  }
  assert.ok(captured, 'client bundle must call window.__ModuleLoader__.load({ id, factory })')
  const loaded = captured as LoadedClientModule

  const react = {
    Fragment: Symbol('Fragment'),
    createElement: () => ({}),
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
  }
  const jsxRuntime = {
    Fragment: react.Fragment,
    jsx: () => ({}),
    jsxs: () => ({}),
  }
  loaded.factory = loaded.factory.bind(loaded)
  const patched: LoadedClientModule = {
    id: loaded.id,
    factory: (require) =>
      loaded.factory((id: string) => {
        if (id === 'react') return react
        if (id === 'react/jsx-runtime') return jsxRuntime
        throw new Error(`unexpected external require in client bundle: ${id}`)
      }) as ReturnType<LoadedClientModule['factory']>,
  }
  return patched
}

function makeSlotContext() {
  const injectCalls: Array<{ key: string; callback: () => unknown }> = []
  const registrations: SlotRegistration[] = []
  let declared = false
  const ctx = {
    slots: {
      inject(key: string, callback: () => unknown) {
        injectCalls.push({ key, callback })
        // Like SlotRegistry.inject: the callback only runs once the slot
        // declaration exists (here: never, until the test declares it).
        return () => {}
      },
      register(options: SlotRegistration['options'], component: unknown) {
        if (!declared) {
          // Exact wording from SlotCore.register.
          throw new Error(
            `slot "${options.name}" is not declared (a parent entry's children table must declare it)`,
          )
        }
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return {
    ctx,
    injectCalls,
    registrations,
    declare() {
      declared = true
    },
  }
}

test('client plugin: built bundle exposes name/inject/apply', () => {
  const loaded = loadClientBundle()
  assert.equal(loaded.id, 'dsh-llm-minimax-oauth')
  const mod = loaded.factory(() => {
    throw new Error('no module should be required for export inspection')
  })
  assert.equal(mod.name, 'llm-minimax-oauth-client')
  assert.deepEqual([...(mod.inject ?? [])], ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('client plugin: apply defers settings.section registration through slots.inject', () => {
  const loaded = loadClientBundle()
  const mod = loaded.factory(() => {
    throw new Error('no module should be required for export inspection')
  })
  const { ctx, injectCalls, registrations, declare } = makeSlotContext()

  // The old eager `slots.register` threw here (undeclared slot) and the
  // client fiber failed, aborting web boot. The inject form must not throw.
  const dispose = mod.apply?.(ctx)
  assert.equal(injectCalls.length, 1, 'apply must call slots.inject exactly once')
  assert.equal(injectCalls[0].key, 'settings.section')
  assert.equal(registrations.length, 0, 'apply must not register before the slot exists')
  assert.equal(typeof dispose, 'function', 'apply must return the inject disposer')

  // Once ui-settings-general declares the slot, the parked callback runs.
  declare()
  injectCalls[0].callback()
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'minimax-oauth')
  assert.equal(options.order, 50)
  assert.equal(options.label?.(), 'MiniMax OAuth')
  assert.equal(typeof component, 'function', 'the OauthSection component must be registered')
})
