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
 * registered through `slots.register` inside `apply`, not re-exported as
 * a default value.
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
  // what `slots.register` accepts; the runtime dispatch is unchanged.
  const clientCtx = ctx as ClientContextWithSlots
  return clientCtx.slots.register(
    {
      name: 'settings.section',
      id: 'minimax-oauth',
      order: 50,
      label: () => 'MiniMax OAuth',
    },
    OauthSection,
  )
}
