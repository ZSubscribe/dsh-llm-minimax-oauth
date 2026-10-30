/**
 * Plugin apply() lifecycle.
 *
 * Strategy:
 *   - Persist OAuth tokens via FileCredentialStore.
 *   - On every token change (login or refresh), write the serialized OAuth
 *     token envelope into the region's env var
 *     (`DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL` for Global,
 *     `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN` for CN) so the in-process
 *     adapters (`MiniMaxAdapter`) can read it at request time and authenticate
 *     the Anthropic Messages request with `Authorization: Bearer
 *     <access_token>`. The env var is the seam: the adapter never touches the
 *     disk store, the disk store never touches HTTP, and a token produced by
 *     either path lights up the matching adapter without reconfiguration.
 *   - Register one `LlmAdapter` instance per region (`minimax-portal` and
 *     `minimax-portal-cn`) so the `LlmRuntime` can dispatch requests to the
 *     right adapter; those ids are distinct from the built-in `pi-ai`
 *     `minimax` route used for the API-key path, keeping the authentication
 *     channels orthogonal.
 *   - Expose a JSON-RPC-like HTTP surface
 *     (`/minimax-oauth/{start,status,logout}`) for the Web UI client.
 *
 * Long-running logins must never reject into the void:
 *   - The token poll runs in a background promise. If the device code expires
 *     (the user never finishes the browser step), polling throws a `timeout`
 *     error minutes later. Node treats an unhandled rejection as fatal by
 *     default, which used to take the entire DSH host down. The flow now
 *     catches every terminal error, records it on the flow for `/status`, and
 *     resolves to `undefined`, so no rejection can escape.
 *   - Each flow owns an `AbortController`; logging out, starting a new login
 *     for the same region, or unloading the plugin aborts the pending poll.
 *     Abort is a cancellation, not an error, and is never reported as one.
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
 * Harness contract implemented here (DSH `0.2.1-rc.5`):
 *   - `ctx.llm.registerAdapter(providers, adapter)` and
 *     `ctx.llm.registerConfigurableProviders(entries)` keep their shapes;
 *     the configurable-provider entry gained `defaultBaseURL` and
 *     `nativeAuth` in `0.2.x`, which this route now declares.
 *   - `ctx.webServer.register({kind, path, handler})` is typed by
 *     `@deepseek-ai/dsh-host-webserver`; the handler receives the raw Node
 *     `IncomingMessage`/`ServerResponse`, so a JSON body must be read from
 *     the request stream rather than read off a `body` property.
 *
 * @module dsh-llm-minimax-oauth/apply
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Imported for its `declare module '@deepseek-ai/cordis'` augmentation, which
// types `ctx.webServer` as the host's `WebServer` service. Without this
// import the augmentation is not part of the program and the routes below
// would fall back to `any`.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { FileCredentialStore, refreshAccessToken, type MiniMaxAuthState } from './store.ts'
import { startAuthorization, waitForToken } from './oauth.ts'
import { resolveHome } from './home.ts'
import {
  DEFAULT_PROVIDER_PROFILES,
  MINIMAX_PROVIDER_ID,
  MINIMAX_REGION_GLOBAL,
  type MiniMaxProviderProfile,
} from './const.ts'
import { MiniMaxAdapter, type SerializedToken } from './adapter.ts'

/**
 * Largest request body the OAuth endpoints accept.
 *
 * The endpoints carry a single provider id, so a kilobyte is already far more
 * than any legitimate request needs. The cap keeps a malformed or hostile
 * request from buffering without bound.
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024

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
function writeTokenToEnv(envVar: string, state: MiniMaxAuthState): void {
  process.env[envVar] = JSON.stringify(serializeToken(state))
}

async function mirrorTokenToEnv(store: FileCredentialStore, profile: MiniMaxProviderProfile): Promise<MiniMaxAuthState | undefined> {
  const state = await store.read(profile.id)
  if (!state) return undefined
  // Refresh if close to expiry.
  const expiresAt = Date.parse(state.expires_at)
  const skewMs = 60_000
  if (Number.isFinite(expiresAt) && Date.now() + skewMs >= expiresAt) {
    try {
      const next = await refreshAccessToken(store, profile, state)
      writeTokenToEnv(profile.envVar, next)
      return next
    } catch {
      // Keep the stale token — refresh errors are surfaced via the last_auth_error.
    }
  }
  writeTokenToEnv(profile.envVar, state)
  return state
}

function profileById(id: string): MiniMaxProviderProfile | undefined {
  return DEFAULT_PROVIDER_PROFILES.find((p) => p.id === id)
}

/**
 * Read one JSON request body from the Node request stream.
 *
 * The host webserver hands the handler a raw `IncomingMessage`; there is no
 * parsed `body` property, so the payload has to be consumed from the stream.
 * A malformed or oversized body yields an empty object, which leaves the
 * caller on its default provider instead of failing the request.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_REQUEST_BODY_BYTES) return {}
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** Write one JSON response with the given status code. */
function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
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
  /**
   * Background token poll. Always resolves: success yields the persisted
   * state, while a terminal failure (device-code timeout, denial, HTTP error)
   * yields `undefined` after recording `error` on the flow.
   *
   * It must never reject: this promise is not awaited by anyone, and Node's
   * default policy for unhandled rejections is to terminate the process.
   * A rejected background poll used to crash the whole DSH host minutes after
   * the user opened the login page.
   */
  promise: Promise<MiniMaxAuthState | undefined>
  /** Cancels the pending poll. Abort is a cancellation, not an error. */
  controller: AbortController
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
    await mirrorTokenToEnv(store, profile)
  }

  /** Per-provider in-flight login state. */
  const inflight = new Map<string, InFlightFlow>()

  const statusOne = async (profile: MiniMaxProviderProfile) => {
    const state = await mirrorTokenToEnv(store, profile)
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
      // race). A flow that already recorded a terminal error is dead: drop it
      // so the user's retry gets a fresh device code instead of the stale one.
      const existing = inflight.get(providerId)
      if (existing !== undefined && existing.error === undefined) {
        return {
          userCode: existing.userCode,
          verificationUri: existing.verificationUri,
          expiresAt: existing.expiresAt,
        }
      }
      if (existing !== undefined) inflight.delete(providerId)

      const { device, start } = await startAuthorization(profile)
      const controller = new AbortController()
      const flowRef: { current: InFlightFlow | undefined } = { current: undefined }
      const promise = (async (): Promise<MiniMaxAuthState | undefined> => {
        try {
          const state = await waitForToken(store, profile, device, start.pkceVerifier, {
            signal: controller.signal,
          })
          writeTokenToEnv(profile.envVar, state)
          return state
        } catch (err) {
          // This poll runs unattended for up to the device-code lifetime. If
          // the user never finishes the browser step it throws a `timeout`
          // error minutes later, and any unhandled rejection here would kill
          // the DSH host. Record the message on the flow (the UI reads it via
          // /status) and resolve instead of rethrowing.
          if (!controller.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err)
            flowRef.current?.setError(message)
          }
          return undefined
        } finally {
          // Keep the in-flight record around long enough for the UI to read
          // the final state via /status, then drop it. `unref` keeps this
          // cleanup timer from holding the host process open.
          const cleanup = setTimeout(() => {
            if (inflight.get(providerId)?.promise === promise) {
              inflight.delete(providerId)
            }
          }, 5_000)
          cleanup.unref?.()
        }
      })()
      const flow: InFlightFlow = {
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        expiresAt: start.expiresAt,
        promise,
        controller,
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
      const flow = inflight.get(providerId)
      inflight.delete(providerId)
      if (flow !== undefined) {
        // Cancel first: a poll that is already sleeping must not write a token
        // back after the user asked to sign out. Waiting for it to settle
        // closes the race where an exchange that just succeeded re-persists a
        // token after the `store.clear` below.
        flow.controller.abort()
        await flow.promise
      }
      await store.clear(providerId)
      const profile = profileById(providerId)
      if (profile !== undefined) delete process.env[profile.envVar]
    },
    homePath: home.credentialsPath,
  }
  ctx.reflect.provide('minimaxOauth', surface)

  // Register one custom adapter per region. Each adapter reads its own env
  // var and uses a Bearer token + the Anthropic Messages wire format; the
  // built-in `pi-ai` `minimax` route (which sends `x-api-key`) is untouched
  // and remains available for the API-key path.
  for (const profile of DEFAULT_PROVIDER_PROFILES) {
    const adapter = new MiniMaxAdapter({
      envVar: profile.envVar,
      providerId: profile.id,
      displayName: `${profile.label} OAuth`,
      store,
    })
    ctx.llm.registerAdapter([profile.id], adapter)
  }
  ctx.llm.registerConfigurableProviders(
    DEFAULT_PROVIDER_PROFILES.map((profile) => ({
      provider: profile.id,
      displayName: `${profile.label} OAuth`,
      // The Global namespace is kept from earlier releases; CN gets its own
      // so the two regions' provider settings cannot overwrite each other.
      settingsNs: profile.id === MINIMAX_REGION_GLOBAL ? 'dsh-llm-minimax-oauth' : 'dsh-llm-minimax-oauth-cn',
      settingsPath: [],
      // Each region has one fixed Anthropic-compatible endpoint; `0.2.x`
      // surfaces read it from the provider directory instead of probing it.
      defaultBaseURL: profile.inferenceBaseUrl,
      // The credential is a stored OAuth sign-in, not an API key: the token
      // envelope lives in the env var the adapter reads.
      nativeAuth: { env: [profile.envVar], oauth: true },
    })),
  )

  // Abort pending device-code polls when the fiber unloads. Without this the
  // background promise would keep polling (and could outlive the plugin),
  // and the host would have no handle to cancel it.
  ctx.effect(() => () => {
    for (const flow of inflight.values()) {
      flow.controller.abort()
    }
    inflight.clear()
  }, 'llm-minimax-oauth: abort in-flight logins on dispose')

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
      sendJson(res, 200, data)
    },
  }), 'llm-minimax-oauth: GET /minimax-oauth/status')

  // Phase-1 endpoint: returns the verification URL + user code immediately
  // and starts token polling in the background. The browser opening is the
  // client's responsibility (window.open in the React component).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/start',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const provider = typeof body.provider === 'string' ? body.provider : MINIMAX_PROVIDER_ID
        const start = await surface.startLogin(provider)
        sendJson(res, 200, {
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: start.expiresAt,
        })
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message })
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
      try {
        const body = await readJsonBody(req)
        const provider = typeof body.provider === 'string' ? body.provider : MINIMAX_PROVIDER_ID
        const start = await surface.startLogin(provider)
        sendJson(res, 200, {
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: start.expiresAt,
        })
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message })
      }
    },
  }), 'llm-minimax-oauth: POST /minimax-oauth/login')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/minimax-oauth/logout',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const provider = typeof body.provider === 'string' ? body.provider : MINIMAX_PROVIDER_ID
        await surface.logout(provider)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message })
      }
    },
  }), 'llm-minimax-oauth: POST /minimax-oauth/logout')
}

// Keep the route type referenced so the `@deepseek-ai/dsh-host-webserver`
// augmentation stays part of this module's type graph even if the handler
// shapes change; the import is also what makes `ctx.webServer` typed.
export type { WebRoute }
