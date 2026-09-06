/**
 * Plugin apply() lifecycle.
 *
 * Strategy:
 *   - Persist OAuth tokens via FileCredentialStore.
 *   - On every token change (login or refresh), write the serialized OAuth
 *     token envelope into the env var `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL`
 *     so the in-process adapter (`MiniMaxAdapter`) can read it at request
 *     time and authenticate the Anthropic Messages request with
 *     `Authorization: Bearer <access_token>`. The env var is the seam: the
 *     adapter never touches the disk store, the disk store never touches
 *     HTTP, and a token produced by either path lights up the same adapter
 *     without reconfiguration.
 *   - Register a single `LlmAdapter` instance for the `minimax-portal` route
 *     so the `LlmRuntime` can dispatch requests to the adapter; the
 *     `minimax-portal` id is distinct from the built-in `pi-ai` `minimax`
 *     route used for the API-key path, keeping the two authentication
 *     channels orthogonal.
 *   - Expose a JSON-RPC-like HTTP surface
 *     (`/minimax-oauth/{start,status,logout}`) for the Web UI client.
 *
 * OAuth flow decoupling (what was broken before):
 *   - Old flow: client POST `/login`, server awaited the whole 60–600s
 *     device-code polling before responding. The response only ever carried
 *     `{ok, expires_at}` (or a 500). The browser was supposed to open from a
 *     server-side `ctx.openExternal` callback that does not exist in the
 *     web harness, so the user stayed on "Waiting for browser…" forever.
 *   - New flow: server returns `{userCode, verificationUri}` from
 *     `POST /start` in well under a second. The client opens the browser
 *     itself with `window.open(verificationUri)`. Token polling runs in the
 *     background and writes to the store on success; the client polls
 *     `GET /status` until `logged_in` flips.
 *
 * @module dsh-llm-minimax-oauth/apply
 */

import type { Context } from '@deepseek-ai/cordis'

// Augment `@deepseek-ai/cordis`'s `Context` interface so TS recognises the
// `webServer` service that the host webserver plugin installs at runtime.
// The runtime reflection layer resolves the property either way; this
// declaration is only for the compiler.
//
// The handler parameter types are `unknown` because the request/response
// shapes that `@deepseek-ai/dsh-host-webserver` would otherwise expose
// (Node `http.IncomingMessage` / `ServerResponse`) sit in a sibling
// workspace package; pulling them in here would force an extra peer
// dependency on this otherwise-self-contained plugin. The plugin's own
// handlers cast each argument to the minimal shape it consumes.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Installed by `@deepseek-ai/dsh-host-webserver`. */
    webServer: {
      register: (route: {
        kind: 'exact'
        path: string
        handler: (req: unknown, res: unknown) => void | Promise<void>
      }) => () => void
    }
  }
}

import { FileCredentialStore, refreshAccessToken, type MiniMaxAuthState } from './store.ts'
import { startAuthorization, waitForToken } from './oauth.ts'
import { resolveHome } from './home.ts'
import {
  DEFAULT_PROVIDER_PROFILES,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_PROVIDER_ID,
  type MiniMaxProviderProfile,
} from './const.ts'
import { MiniMaxAdapter, type SerializedToken } from './adapter.ts'

function serializeToken(state: MiniMaxAuthState): SerializedToken {
  return {
    access: state.access_token,
    refresh: state.refresh_token,
    expires_at: state.expires_at,
    inference_base_url: state.inference_base_url,
    oauth_base_url: state.oauth_base_url,
  }
}

/**
 * Mirror a fresh token state to the inference env var.
 *
 * The env var is read by the in-process adapter on every request; the disk
 * store is the durable source of truth. Both writers converge here so the
 * next request after a login or a refresh always sees the freshest access
 * token and never a stale one written by a previous boot.
 */
function writeTokenToEnv(state: MiniMaxAuthState): void {
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(serializeToken(state))
}

async function mirrorTokenToEnv(store: FileCredentialStore, providerId: string): Promise<MiniMaxAuthState | undefined> {
  const state = await store.read(providerId)
  if (!state) return undefined
  // Refresh if close to expiry.
  const expiresAt = Date.parse(state.expires_at)
  const skewMs = 60_000
  if (Number.isFinite(expiresAt) && Date.now() + skewMs >= expiresAt) {
    try {
      const next = await refreshAccessToken(store, profileById(providerId)!, state)
      writeTokenToEnv(next)
      return next
    } catch {
      // Keep the stale token — refresh errors are surfaced via the last_auth_error.
    }
  }
  writeTokenToEnv(state)
  return state
}

function profileById(id: string): MiniMaxProviderProfile | undefined {
  return DEFAULT_PROVIDER_PROFILES.find((p) => p.id === id)
}

/**
 * Per-provider state of an in-flight OAuth device-code flow.
 *
 * Multiple simultaneous `start` calls for the same provider are deduped:
 * only one device code is requested, and the existing `start` payload is
 * returned. The `error` field is set if the background polling fails
 * terminally so the UI can surface the reason instead of waiting out the
 * device-code deadline.
 */
interface InFlightFlow {
  userCode: string
  verificationUri: string
  /** Absolute device-code expiry in unix seconds. */
  expiresAt: number
  /** Resolves to the persisted state when authorization succeeds. */
  promise: Promise<MiniMaxAuthState>
  /** Stored alongside the resolved state so /status can report it. */
  setError: (message: string | undefined) => void
  error?: string
}

export async function apply(ctx: Context) {
  const home = await resolveHome()
  const store = new FileCredentialStore(home.credentialsPath)

  // Mirror any existing tokens to env on boot so the very first request
  // after a restart already sees a usable Bearer token.
  for (const profile of DEFAULT_PROVIDER_PROFILES) {
    await mirrorTokenToEnv(store, profile.id)
  }

  /** Per-provider in-flight login state. */
  const inflight = new Map<string, InFlightFlow>()

  const statusOne = async (profile: MiniMaxProviderProfile) => {
    const state = await mirrorTokenToEnv(store, profile.id)
    const base = {
      provider: profile,
      logged_in: false,
      expires_at: undefined as string | undefined,
      error: undefined as string | undefined,
      pending: undefined as InFlightFlow | undefined,
    }
    if (state) {
      base.logged_in = !state.last_auth_error
      base.expires_at = state.expires_at
      base.error = state.last_auth_error?.message
    }
    const flow = inflight.get(profile.id)
    if (flow) {
      base.pending = flow
      base.error = flow.error ?? base.error
    }
    return base
  }

  const surface = {
    store,
    profiles: DEFAULT_PROVIDER_PROFILES,
    async status() {
      return Promise.all(DEFAULT_PROVIDER_PROFILES.map(statusOne))
    },
    /**
     * Phase 1 of the OAuth flow: request a device code and start polling in
     * the background. Returns the URL and user code immediately so the HTTP
     * handler can return to the browser without holding the connection.
     */
    async startLogin(providerId: string): Promise<{ userCode: string; verificationUri: string; expiresAt: number }> {
      const profile = profileById(providerId)
      if (!profile) throw new Error(`Unknown MiniMax provider id: ${providerId}`)

      // Idempotent: if a flow is already in flight, return its current data
      // rather than requesting a second device code (the portal would then
      // show two different user codes, and the second poll could win the
      // race).
      const existing = inflight.get(providerId)
      if (existing) {
        return {
          userCode: existing.userCode,
          verificationUri: existing.verificationUri,
          expiresAt: existing.expiresAt,
        }
      }

      const { device, start } = await startAuthorization(profile)
      const flowRef: { current: InFlightFlow | undefined } = { current: undefined }
      const promise = (async () => {
        try {
          const state = await waitForToken(store, profile, device, start.pkceVerifier)
          writeTokenToEnv(state)
          return state
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          flowRef.current?.setError(message)
          throw err
        } finally {
          // Keep the in-flight record around long enough for the UI to read
          // the final state via /status, then drop it on next tick.
          setTimeout(() => {
            if (inflight.get(providerId)?.promise === promise) {
              inflight.delete(providerId)
            }
          }, 5_000)
        }
      })()
      const flow: InFlightFlow = {
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        expiresAt: start.expiresAt,
        promise,
        setError: (message) => {
          if (message !== undefined) flow.error = message
          else delete flow.error
        },
      }
      flowRef.current = flow
      inflight.set(providerId, flow)
      return {
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        expiresAt: start.expiresAt,
      }
    },
    async logout(providerId: string) {
      inflight.delete(providerId)
      await store.clear(providerId)
      delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    },
    homePath: home.credentialsPath,
  }
  ctx.reflect.provide('minimaxOauth', surface)

  // Register the custom adapter. The adapter owns `Bearer` authentication
  // and the Anthropic Messages wire format; the built-in `pi-ai` `minimax`
  // route (which sends `x-api-key`) is untouched and remains available for
  // the API-key path.
  const adapter = new MiniMaxAdapter({ envVar: MINIMAX_INFERENCE_ENV_VAR, store })
  ctx.llm.registerAdapter([MINIMAX_PROVIDER_ID], adapter)
  ctx.llm.registerConfigurableProviders([
    {
      provider: MINIMAX_PROVIDER_ID,
      displayName: 'MiniMax (OAuth)',
      settingsNs: 'dsh-llm-minimax-oauth',
      settingsPath: [],
    },
  ])

  // HTTP endpoints for the Web UI.
  //
  // Each route is registered through `ctx.effect(() => ctx.webServer.register(...))`
  // so the route disposer is tracked on the fiber lifecycle. The DSH
  // convention (`packages/AGENTS.md`: "Registrations are effects: every
  // contribution goes through `ctx.effect()` / `ctx.on()`; a registry's
  // `register()` returns the disposer.") requires this wrapping; bare
  // `ctx.webServer.register(...)` calls bypass the disposer tracker and
  // leave the route table with no tear-down hook on fiber unload. Every
  // DSH built-in that owns HTTP routes follows this exact shape (see
  // `packages/client/{connection,modules,hmr}/src/`).
  // DSH built-ins (`packages/client/{connection,modules,hmr}/src/`) call
  // `ctx.webServer.register(...)` directly: the method is invoked on the
  // Reflect proxy so `this` is bound to the WebServer instance at call time.
  // Detaching the reference (`const r = ctx.webServer.register`) breaks
  // the binding and crashes with `Cannot read properties of undefined
  // (reading 'exact')` at `register()` line 109. We mirror the built-ins
  // and call the method directly in each `ctx.effect` callback.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/status',
    handler: async (_req, res) => {
      const data = await surface.status()
      const r = res as { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (body: string) => void }
      r.statusCode = 200
      r.setHeader?.('Content-Type', 'application/json')
      r.end?.(JSON.stringify(data))
    },
  }), 'llm-minimax-oauth: GET /minimax-oauth/status')

  // Phase-1 endpoint: returns the verification URL + user code immediately
  // and starts token polling in the background. The browser opening is the
  // client's responsibility (window.open in the React component).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/start',
    handler: async (req, res) => {
      const r = res as { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (body: string) => void }
      try {
        const body = typeof (req as { body?: { provider?: string } }).body === 'object'
          ? (req as { body: { provider: string } }).body
          : { provider: MINIMAX_PROVIDER_ID }
        const start = await surface.startLogin(body.provider ?? MINIMAX_PROVIDER_ID)
        r.statusCode = 200
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: start.expiresAt,
        }))
      } catch (err) {
        r.statusCode = 500
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({ error: (err as Error).message }))
      }
    },
  }), 'llm-minimax-oauth: POST /minimax-oauth/start')

  // Backwards-compatible alias for older clients still calling `/login`.
  // Returns the same `{userCode, verificationUri}` shape as `/start`; the
  // browser must open the URL itself.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/login',
    handler: async (req, res) => {
      const r = res as { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (body: string) => void }
      try {
        const body = typeof (req as { body?: { provider?: string } }).body === 'object'
          ? (req as { body: { provider: string } }).body
          : { provider: MINIMAX_PROVIDER_ID }
        const start = await surface.startLogin(body.provider ?? MINIMAX_PROVIDER_ID)
        r.statusCode = 200
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: start.expiresAt,
        }))
      } catch (err) {
        r.statusCode = 500
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({ error: (err as Error).message }))
      }
    },
  }), 'llm-minimax-oauth: POST /minimax-oauth/login')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/logout',
    handler: async (req, res) => {
      const r = res as { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (body: string) => void }
      try {
        const body = typeof (req as { body?: { provider?: string } }).body === 'object'
          ? (req as { body: { provider: string } }).body
          : { provider: MINIMAX_PROVIDER_ID }
        await surface.logout(body.provider ?? MINIMAX_PROVIDER_ID)
        r.statusCode = 200
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({ ok: true }))
      } catch (err) {
        r.statusCode = 500
        r.setHeader?.('Content-Type', 'application/json')
        r.end?.(JSON.stringify({ error: (err as Error).message }))
      }
    },
  }), 'llm-minimax-oauth: POST /minimax-oauth/logout')
}
