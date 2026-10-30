/**
 * Client-side plugin apply() lifecycle.
 *
 * Adds a dedicated Settings section titled "MiniMax OAuth" where users can
 * click "Login with MiniMax" / "Logout" buttons and see login status. The
 * `OauthSection` component is registered as the body of the
 * `settings.section` slot, calling the host apply()'s `/minimax-oauth/*`
 * JSON endpoints.
 *
 * Export discipline follows DSH UI plugin conventions
 * (`packages/client/AGENTS.md` and the slot-catalog examples in
 * `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`):
 * only `name`, `inject`, and `apply` are exported. The `inject` array must
 * declare `slots` — every cordis fiber property access (`ctx.slots`,
 * `ctx.<service>`) goes through `ReflectService.handler.get`, which throws
 * `cannot get property "slots" without inject` when the service is not
 * declared in `inject`. The slot-catalog examples are unanimous on this
 * shape (`{ inject: ['slots'], apply(ctx) { ctx.slots.inject(...) } }`),
 * and so is the ui-settings-general plugin which renders this exact
 * `settings.section` slot the package owns. The React component is
 * registered through `slots.inject` + `slots.register` inside `apply`,
 * not re-exported as a default value.
 *
 * `settings.section` is declared by ui-settings-general as a child of the
 * `sidebar.settings` slot it registers. Client plugin activation order is
 * not guaranteed, so a direct `slots.register` from this plugin can run
 * before that declaration and throws `slot "settings.section" is not
 * declared` — which fails this plugin's fiber and, in DSH 0.2.1,
 * aborts the whole web boot ("web boot: 1 entry did not activate").
 * `slots.inject(key, callback)` parks the contribution on the caller's
 * fiber until the slot is declared and disposes it again if the
 * declaration collapses, which is the supported way to contribute to a
 * slot owned by another plugin.
 *
 * @module dsh-llm-minimax-oauth/client/apply
 */

import type { Context } from '@deepseek-ai/cordis'
import OauthSection from './index.tsx'

/**
 * `ctx.slots` is exposed by the runtime through the Reflect property proxy
 * (`vendor/cordis/src/reflect.ts:152`); the static `Context` type does not
 * declare it. The runtime resolves it because `slots` is in `inject`
 * above, and the cast below is a static-only adapter.
 */
type ClientContextWithSlots = Context & {
  slots: {
    /**
     * Contribute to a slot owned by another plugin. The callback runs once
     * the slot is declared (synchronously if it already is), and its
     * disposer runs when the declaration collapses or this fiber unloads.
     */
    inject: (key: string, callback: () => (() => void) | void) => () => void
    register: (
      entry: {
        name: string
        id: string
        order: number
        label?: () => string
        children?: Record<string, { kind: 'list' | 'single'; scope: 'root' | string }>
        locale?: string
      },
      Component: typeof OauthSection,
    ) => () => void
  }
}

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'llm-minimax-oauth-client'

/**
 * Services the fiber must resolve before `apply` runs. `slots` is the only
 * required declaration here: this plugin reads `ctx.slots` to register the
 * settings section, and the cordis property proxy throws on access without
 * the matching inject entry.
 */
export const inject: readonly string[] = ['slots']

export const apply = (ctx: Context): (() => void) | void => {
  // `ctx.slots` is reachable because `slots` is declared in `inject`
  // above; reading through the Reflect proxy now resolves to the runtime
  // slot registry instead of throwing. The cast narrows the static type to
  // what `slots.inject` / `slots.register` accept; the runtime dispatch is
  // unchanged.
  const clientCtx = ctx as ClientContextWithSlots
  // Never call `register` directly here: activation order can put this
  // plugin's apply before ui-settings-general declares `settings.section`,
  // and SlotRegistry.register throws on an undeclared slot (killing the
  // client fiber and the whole web boot). `inject` waits for the
  // declaration, then registers on this fiber's behalf.
  return clientCtx.slots.inject('settings.section', () =>
    clientCtx.slots.register(
      {
        name: 'settings.section',
        id: 'minimax-oauth',
        order: 50,
        label: () => 'MiniMax OAuth',
      },
      OauthSection,
    ),
  )
}
