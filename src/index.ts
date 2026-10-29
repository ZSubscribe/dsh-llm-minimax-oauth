/**
 * Public surface of the dsh-llm-minimax-oauth plugin.
 *
 * Install with:
 *   dsh plugin --profile web add ./dsh-llm-minimax-oauth
 *
 * @module dsh-llm-minimax-oauth
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'llm-minimax-oauth'

/** Services that must exist before the plugin is applied. */
export const inject = ['llm', 'webServer']

export {
  DEFAULT_PROVIDER_PROFILES,
  MINIMAX_ANTHROPIC_VERSION,
  MINIMAX_DEFAULT_MAX_TOKENS,
  MINIMAX_DEFAULT_CONTEXT_WINDOW,
  MINIMAX_DEFAULT_MODEL_CATALOG,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_INFERENCE_ENV_VAR_CN,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_SCOPE,
  MINIMAX_OAUTH_USER_CODE_GRANT,
  MINIMAX_OAUTH_REFRESH_GRANT,
  MINIMAX_OAUTH_REFRESH_SKEW_SECONDS,
  MINIMAX_OAUTH_POLL_INTERVAL_MS,
  MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS,
  MINIMAX_PROVIDER_ID,
  MINIMAX_PROVIDER_ID_CN,
  MINIMAX_REGION_GLOBAL,
  MINIMAX_REGION_CN,
} from './const.ts'
export type { MiniMaxProviderProfile, MiniMaxCatalogModel } from './const.ts'

export { FileCredentialStore, resolveAccessToken, refreshAccessToken, MiniMaxOAuthError } from './store.ts'
export type { MiniMaxAuthState } from './store.ts'

export { runAuthorization, startAuthorization, waitForToken, generatePkcePair, requestDeviceCode, pollForToken, expiredInToUnixSeconds } from './oauth.ts'
export type { DeviceCodeResponse, PollOptions, AuthorizationResult, AuthorizationStart } from './oauth.ts'

export { MiniMaxAdapter, readSerializedToken } from './adapter.ts'
export type { SerializedToken } from './adapter.ts'

/**
 * Brand constructors for the harness message vocabulary.
 *
 * Re-exported so a plugin author (or a test) can build a valid message
 * without depending on `@deepseek-ai/dsh-llm` directly: `MessageId` brands a
 * message identity and `ToolCallId` brands the tool-call correlation that
 * the `0.2.x` message model carries on `role: 'tool'` messages.
 */
export { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'

export { apply } from './apply.ts'
