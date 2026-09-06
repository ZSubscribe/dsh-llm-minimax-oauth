/**
 * Persistent credential store for MiniMax OAuth tokens.
 *
 * Tokens live in `$DSH_HOME/minimax-oauth.json` (default `~/.dsh/minimax-oauth.json`).
 * The file is written atomically and the access token is refreshed transparently
 * on each read when within `MINIMAX_OAUTH_REFRESH_SKEW_SECONDS` of expiry.
 *
 * @module dsh-llm-minimax-oauth/store
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_REFRESH_GRANT,
  MINIMAX_OAUTH_REFRESH_SKEW_SECONDS,
  MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS,
  type MiniMaxProviderProfile,
} from './const.ts'

export interface MiniMaxAuthState {
  provider_id: string
  oauth_base_url: string
  inference_base_url: string
  client_id: string
  access_token: string
  refresh_token: string
  obtained_at: string
  expires_at: string
  expires_in: number
  /** Set when the refresh failed terminally; UI shows a re-login banner. */
  last_auth_error?: { code: string; message: string; at: string }
}

interface PersistedEnvelope {
  version: 1
  providers: Record<string, MiniMaxAuthState>
}

export class FileCredentialStore {
  constructor(private readonly path: string) {}

  async read(providerId: string): Promise<MiniMaxAuthState | undefined> {
    const env = await this.readEnvelope()
    return env.providers[providerId]
  }

  async write(state: MiniMaxAuthState): Promise<void> {
    const env = await this.readEnvelope()
    env.providers[state.provider_id] = state
    await this.writeEnvelope(env)
  }

  async clear(providerId: string): Promise<void> {
    const env = await this.readEnvelope()
    delete env.providers[providerId]
    await this.writeEnvelope(env)
  }

  async list(): Promise<MiniMaxAuthState[]> {
    const env = await this.readEnvelope()
    return Object.values(env.providers)
  }

  private async readEnvelope(): Promise<PersistedEnvelope> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as PersistedEnvelope
      if (parsed.version === 1 && parsed.providers) return parsed
      return { version: 1, providers: {} }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, providers: {} }
      }
      throw err
    }
  }

  private async writeEnvelope(env: PersistedEnvelope): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(env, null, 2), 'utf8')
    await fs.rename(tmp, this.path)
  }
}

export async function resolveAccessToken(
  store: FileCredentialStore,
  profile: MiniMaxProviderProfile,
  opts: { refresh?: () => Promise<MiniMaxAuthState> } = {},
): Promise<string> {
  const state = await store.read(profile.id)
  if (!state) {
    throw new MiniMaxOAuthError(
      `Not logged into MiniMax OAuth (provider=${profile.id}).`,
      'not_logged_in',
    )
  }
  if (state.last_auth_error) {
    throw new MiniMaxOAuthError(
      `MiniMax OAuth session is invalid: ${state.last_auth_error.message}. Please re-login.`,
      'session_invalid',
    )
  }

  const expiresAt = Date.parse(state.expires_at)
  const skewMs = MINIMAX_OAUTH_REFRESH_SKEW_SECONDS * 1000
  if (Number.isFinite(expiresAt) && Date.now() + skewMs < expiresAt) {
    return state.access_token
  }

  // Refresh path: either inline (caller provided `refresh`) or self-call.
  const refresh = opts.refresh ?? ((s: MiniMaxAuthState) => refreshAccessToken(store, profile, s))
  const refreshed = await refresh(state)
  return refreshed.access_token
}

export async function refreshAccessToken(
  store: FileCredentialStore,
  _profile: MiniMaxProviderProfile,
  state: MiniMaxAuthState,
): Promise<MiniMaxAuthState> {
  if (!state.refresh_token) {
    throw new MiniMaxOAuthError(
      'No refresh_token on file; please re-login.',
      'no_refresh_token',
    )
  }

  const form = new URLSearchParams({
    grant_type: MINIMAX_OAUTH_REFRESH_GRANT,
    client_id: state.client_id || MINIMAX_OAUTH_CLIENT_ID,
    refresh_token: state.refresh_token,
  })

  const res = await fetch(`${state.oauth_base_url}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000),
  })

  if (!res.ok) {
    const body = await res.text()
    const lower = body.toLowerCase()
    const relogin = lower.includes('invalid_grant') || lower.includes('refresh_token_reused') || lower.includes('invalid_refresh_token')
    const err = new MiniMaxOAuthError(
      `MiniMax OAuth refresh failed: ${body || res.statusText}`,
      'refresh_failed',
    )
    if (relogin) err.reloginRequired = true
    throw err
  }

  const payload = (await res.json()) as { access_token?: string; refresh_token?: string; expired_in?: number; status?: string }
  if (payload.status && payload.status !== 'success') {
    const err = new MiniMaxOAuthError(`MiniMax OAuth refresh status=${payload.status}`, 'refresh_failed')
    err.reloginRequired = true
    throw err
  }
  if (!payload.access_token) {
    const err = new MiniMaxOAuthError('MiniMax OAuth refresh missing access_token', 'token_incomplete')
    err.reloginRequired = true
    throw err
  }

  const expiredInMs = payload.expired_in ?? 0
  const newState: MiniMaxAuthState = {
    ...state,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || state.refresh_token,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiredInMs).toISOString(),
    expires_in: Math.floor(expiredInMs / 1000),
  }
  await store.write(newState)
  return newState
}

export class MiniMaxOAuthError extends Error {
  reloginRequired = false
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'MiniMaxOAuthError'
  }
}
