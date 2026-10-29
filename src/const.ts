/**
 * MiniMax OAuth constants and helpers shared between runtime, client, and CLI.
 *
 * Two regions are supported, each with its own OAuth host, inference host and
 * provider route:
 *
 *   - Global: `account.minimax.io` + `api.minimax.io/anthropic`
 *   - CN:     `account.minimaxi.com` + `api.minimaxi.com/anthropic`
 *
 * Endpoint URLs, grant identifiers, and PKCE method are derived from the
 * OpenClaw reference implementation:
 *   https://github.com/openclaw/openclaw/blob/main/extensions/minimax/oauth.ts
 *
 * @module dsh-llm-minimax-oauth/const
 */

/** Public client id registered with the MiniMax portal (matches OpenClaw). */
export const MINIMAX_OAUTH_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113'

/** OAuth scope requested during device-code authorization (matches OpenClaw). */
export const MINIMAX_OAUTH_SCOPE = 'group_id profile model.completion'

/** Grant type for the device-code → token exchange (matches OpenClaw). */
export const MINIMAX_OAUTH_USER_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:user_code'

/** Standard refresh-token grant for the silent refresh path. */
export const MINIMAX_OAUTH_REFRESH_GRANT = 'refresh_token'

/** Refresh the access token when it expires within this many seconds. */
export const MINIMAX_OAUTH_REFRESH_SKEW_SECONDS = 60

/** Per-request poll interval (ms) for the device-code authorization step. */
export const MINIMAX_OAUTH_POLL_INTERVAL_MS = 2000

/** Network timeout for OAuth HTTP calls. */
export const MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS = 15

/**
 * Env var carrying the serialized OAuth access token that the
 * `MiniMaxAdapter` reads at request time.
 *
 * The value is a JSON envelope produced by `serializeToken()` and consumed
 * by `readSerializedToken()`. Authentication leaves the harness through the
 * `Authorization: Bearer <access>` header; this env var is the seam between
 * OAuth login (which writes it) and the request layer (which reads it).
 */
export const MINIMAX_INFERENCE_ENV_VAR = 'DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL'

/**
 * Env var carrying the serialized OAuth access token for MiniMax (CN).
 *
 * Each region needs its own env var: the two profiles are independent, and a
 * shared variable would let a CN login silently overwrite a Global session
 * (and vice versa). The Global var above is kept unchanged for compatibility
 * with existing installations.
 */
export const MINIMAX_INFERENCE_ENV_VAR_CN = 'DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN'

/**
 * Provider route id registered with `ctx.llm.registerAdapter()`.
 *
 * Distinct from `MINIMAX_REGION_GLOBAL` because the route is what the
 * `LlmRuntime` sees; the region id is the OAuth-profile label we keep for
 * store-level naming.
 */
export const MINIMAX_PROVIDER_ID = 'minimax-portal'

/** Provider route id for MiniMax (CN). */
export const MINIMAX_PROVIDER_ID_CN = 'minimax-portal-cn'

/** Default region id (matches the OAuth profile label). */
export const MINIMAX_REGION_GLOBAL = 'minimax-portal'

/** Region id for MiniMax (CN) (matches the OAuth profile label). */
export const MINIMAX_REGION_CN = 'minimax-portal-cn'

/** Anthropic Messages API version header value. */
export const MINIMAX_ANTHROPIC_VERSION = '2023-06-01'

/** Default `max_tokens` when the caller does not pass one. */
export const MINIMAX_DEFAULT_MAX_TOKENS = 8192

/** Default context window for an unconfigured model. */
export const MINIMAX_DEFAULT_CONTEXT_WINDOW = 1_000_000

/** Per-model metadata advertised by `MiniMaxAdapter.listModels`. */
export interface MiniMaxCatalogModel {
  id: string
  name: string
  description?: string
  contextWindow: number
  maxTokens: number
}

/**
 * Default model catalog for the MiniMax Coding Plan OAuth (Global and CN).
 *
 * The list is sourced from `pi-ai`'s built-in `minimax` provider data file
 * (verified against `@earendil-works/pi-ai@1.1.0/dist/providers/data/minimax.json`)
 * and from the OpenClaw reference catalog
 * (`extensions/minimax/provider-models.ts`). Adding or removing models here
 * is a single-source-of-truth change: `listModels()` and `resolveModel()`
 * both read from this array.
 *
 * The catalog advertises the *provider's* context window and output cap.
 * The route itself is text-only: `MiniMaxAdapter` has no access to the
 * attachment service, so it declares `inputModalities: ['text']` and the
 * harness projects images to deterministic text instead of failing the call.
 */
export const MINIMAX_DEFAULT_MODEL_CATALOG: readonly MiniMaxCatalogModel[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    description: 'Latest MiniMax flagship model, 1M context (recommended).',
    contextWindow: 1_000_000,
    maxTokens: 524_288,
  },
  {
    id: 'MiniMax-M3.1-Flash',
    name: 'MiniMax M3.1 Flash',
    description: 'Lower-cost M3.1 variant, 1M context.',
    contextWindow: 1_000_000,
    maxTokens: 524_288,
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    description: 'Mid-generation MiniMax model with extended thinking.',
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    description: 'Higher-throughput M2.7 variant.',
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
]

export interface MiniMaxProviderProfile {
  id: string
  label: string
  /** Base URL for OAuth device-code and token endpoints. */
  oauthBaseUrl: string
  /** Base URL for the Anthropic-compatible inference endpoint. */
  inferenceBaseUrl: string
  /**
   * Process-env variable that carries this profile's serialized token.
   *
   * Each region owns one variable so the two profiles can be logged in at the
   * same time without clobbering each other.
   */
  envVar: string
}

/**
 * MiniMax provider profiles supported by this plugin.
 *
 * - Global: `oauthBaseUrl` matches OpenClaw's
 *   `oauthBaseUrl: "https://account.minimax.io"`; `inferenceBaseUrl` matches
 *   OpenClaw's `baseUrl: "https://api.minimax.io"` plus the Anthropic-compatible
 *   path `/anthropic`.
 * - CN: the mainland-China equivalents, `https://account.minimaxi.com` and
 *   `https://api.minimaxi.com/anthropic` (same public client id, same device
 *   code flow).
 *
 * Both regions use the same public OAuth client id and scope; only the hosts
 * and the provider route differ.
 */
export const DEFAULT_PROVIDER_PROFILES: readonly MiniMaxProviderProfile[] = [
  {
    id: MINIMAX_REGION_GLOBAL,
    label: 'MiniMax (Global)',
    oauthBaseUrl: 'https://account.minimax.io',
    inferenceBaseUrl: 'https://api.minimax.io/anthropic',
    envVar: MINIMAX_INFERENCE_ENV_VAR,
  },
  {
    id: MINIMAX_REGION_CN,
    label: 'MiniMax (CN)',
    oauthBaseUrl: 'https://account.minimaxi.com',
    inferenceBaseUrl: 'https://api.minimaxi.com/anthropic',
    envVar: MINIMAX_INFERENCE_ENV_VAR_CN,
  },
] as const