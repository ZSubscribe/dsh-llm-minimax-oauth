/**
 * MiniMax Global OAuth device-code PKCE flow.
 *
 * 1. POST {oauthBaseUrl}/oauth2/device/code (form-encoded) → user_code, verification_uri, expired_in, interval, state
 * 2. Browser opens verification_uri; user signs in and enters the user_code
 * 3. POST {oauthBaseUrl}/oauth2/token (form-encoded) with grant_type=user_code → access_token, refresh_token, expired_in
 * 4. Persist token via FileCredentialStore; mirror access_token to MINIMAX_API_KEY
 *    so the built-in `pi-ai` `minimax` adapter can use it
 *
 * Endpoint shape, scope, grant type, and PKCE method mirror the OpenClaw
 * reference implementation:
 *   https://github.com/openclaw/openclaw/blob/main/extensions/minimax/oauth.ts
 *
 * @module dsh-llm-minimax-oauth/oauth
 */

import { webcrypto as crypto } from 'node:crypto'
import {
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_SCOPE,
  MINIMAX_OAUTH_USER_CODE_GRANT,
  MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS,
  MINIMAX_OAUTH_POLL_INTERVAL_MS,
  type MiniMaxProviderProfile,
} from './const.ts'
import { FileCredentialStore, type MiniMaxAuthState, MiniMaxOAuthError } from './store.ts'

export interface DeviceCodeResponse {
  user_code: string
  verification_uri: string
  /** Either absolute unix-ms or TTL seconds; resolved at exchange time. */
  expired_in: number
  interval?: number
  state: string
}

export interface AuthorizationResult {
  state: MiniMaxAuthState
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string; state: string }> {
  // Verifier: 64 random url-safe bytes → take first 96 chars (matches Hermes).
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64))
  const verifier = Buffer.from(verifierBytes).toString('base64url').slice(0, 96)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(digest)
  const stateBytes = crypto.getRandomValues(new Uint8Array(16))
  const state = Buffer.from(stateBytes).toString('base64url')
  return { verifier, challenge, state }
}

function expiredInToUnixSeconds(expiredIn: number): number {
  // MiniMax returns either absolute unix-ms or TTL seconds. Same heuristic as Hermes.
  if (expiredIn > Date.now() / 2) return expiredIn / 1000
  return Date.now() / 1000 + Math.max(1, expiredIn)
}

export { expiredInToUnixSeconds }

export async function requestDeviceCode(
  profile: MiniMaxProviderProfile,
  pkce: { challenge: string; state: string },
  opts: { signal?: AbortSignal } = {},
): Promise<DeviceCodeResponse> {
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    scope: MINIMAX_OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  })

  const res = await fetch(`${profile.oauthBaseUrl}/oauth2/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-request-id': crypto.randomUUID(),
    },
    body: form.toString(),
    // The request owns a hard timeout; the caller's signal is folded in so a
    // cancelled login stops the in-flight HTTP call instead of waiting the
    // full timeout out.
    signal: opts.signal === undefined
      ? AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000)
      : AbortSignal.any([
        AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000),
        opts.signal,
      ]),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new MiniMaxOAuthError(
      `MiniMax OAuth authorization failed: ${body || res.statusText}`,
      'authorization_failed',
    )
  }

  const payload = (await res.json()) as Partial<DeviceCodeResponse>
  for (const field of ['user_code', 'verification_uri', 'expired_in'] as const) {
    if (payload[field] === undefined) {
      throw new MiniMaxOAuthError(
        `MiniMax OAuth response missing field: ${field}`,
        'authorization_incomplete',
      )
    }
  }
  if (payload.state !== pkce.state) {
    throw new MiniMaxOAuthError(
      'MiniMax OAuth state mismatch (possible CSRF).',
      'state_mismatch',
    )
  }
  return payload as DeviceCodeResponse
}

export interface PollOptions {
  signal?: AbortSignal
  onPending?: () => void
}

export async function pollForToken(
  profile: MiniMaxProviderProfile,
  device: DeviceCodeResponse,
  pkce: { verifier: string },
  opts: PollOptions = {},
): Promise<{ access_token: string; refresh_token: string; expired_in: number; status: string }> {
  const deadlineUnix = expiredInToUnixSeconds(device.expired_in)
  const intervalMs = Math.max(2000, device.interval ?? MINIMAX_OAUTH_POLL_INTERVAL_MS)

  while (Date.now() / 1000 < deadlineUnix) {
    if (opts.signal?.aborted) {
      throw new MiniMaxOAuthError('MiniMax OAuth polling aborted.', 'aborted')
    }

    const form = new URLSearchParams({
      grant_type: MINIMAX_OAUTH_USER_CODE_GRANT,
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      user_code: device.user_code,
      code_verifier: pkce.verifier,
    })

    const res = await fetch(`${profile.oauthBaseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
      signal: opts.signal ?? AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new MiniMaxOAuthError(
        `MiniMax OAuth token exchange failed: ${body || res.statusText}`,
        'token_exchange_failed',
      )
    }

    const payload = (await res.json()) as { status?: string; access_token?: string; refresh_token?: string; expired_in?: number }
    const status = payload.status
    if (status === 'error') {
      throw new MiniMaxOAuthError(
        'MiniMax OAuth reported an error. Please try again later.',
        'authorization_denied',
      )
    }
    if (status === 'success') {
      if (!payload.access_token || !payload.refresh_token || !payload.expired_in) {
        throw new MiniMaxOAuthError(
          'MiniMax OAuth success payload missing required token fields.',
          'token_incomplete',
        )
      }
      return payload as { access_token: string; refresh_token: string; expired_in: number; status: string }
    }
    opts.onPending?.()
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  throw new MiniMaxOAuthError(
    'MiniMax OAuth timed out before authorization completed.',
    'timeout',
  )
}

export async function runAuthorization(
  store: FileCredentialStore,
  profile: MiniMaxProviderProfile,
  opts: {
    signal?: AbortSignal
    openBrowser?: (url: string) => Promise<boolean> | boolean
    onUserCode?: (info: { verificationUri: string; userCode: string }) => void
  } = {},
): Promise<AuthorizationResult> {
  const pkce = await generatePkcePair()
  const device = await requestDeviceCode(profile, pkce)

  opts.onUserCode?.({ verificationUri: device.verification_uri, userCode: device.user_code })

  if (opts.openBrowser) {
    try {
      await opts.openBrowser(device.verification_uri)
    } catch {
      // Browser open failure is non-fatal; user can copy the URL.
    }
  }

  const token = await pollForToken(
    profile,
    device,
    pkce,
    opts.signal ? { signal: opts.signal } : {},
  )

  const expiresUnix = expiredInToUnixSeconds(token.expired_in)
  const state: MiniMaxAuthState = {
    provider_id: profile.id,
    oauth_base_url: profile.oauthBaseUrl,
    inference_base_url: profile.inferenceBaseUrl,
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(expiresUnix * 1000).toISOString(),
    expires_in: Math.max(0, Math.floor(expiresUnix - Date.now() / 1000)),
  }
  await store.write(state)
  return { state }
}

/**
 * Phase 1 of the OAuth flow: request a device code, return to the caller
 * immediately so the client can render the URL and (optionally) open it.
 * Polling for the issued token is the caller's responsibility via
 * {@link waitForToken} so the HTTP handler can return to the browser
 * without holding the connection open for 60+ seconds.
 *
 * Shape mirrors {@link requestDeviceCode} so callers don't need a second
 * type for the early-return payload.
 */
export interface AuthorizationStart {
  userCode: string
  verificationUri: string
  /** PKCE verifier; pass back to {@link waitForToken}. */
  pkceVerifier: string
  /** Absolute device-code expiry in unix seconds. */
  expiresAt: number
}

export async function startAuthorization(
  profile: MiniMaxProviderProfile,
  opts: { signal?: AbortSignal } = {},
): Promise<{ device: DeviceCodeResponse; start: AuthorizationStart }> {
  const pkce = await generatePkcePair()
  const device = await requestDeviceCode(profile, pkce, opts.signal ? { signal: opts.signal } : {})
  const start: AuthorizationStart = {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    pkceVerifier: pkce.verifier,
    expiresAt: expiredInToUnixSeconds(device.expired_in),
  }
  return { device, start }
}

/**
 * Phase 2 of the OAuth flow: poll until the user authorizes the device
 * code or the deadline elapses. Persist the resulting {@link MiniMaxAuthState}
 * to `store` so subsequent boots keep the credential.
 *
 * Returns the persisted state. Callers that don't need persistence can
 * invoke {@link pollForToken} directly with `device` and `pkce`.
 */
export async function waitForToken(
  store: FileCredentialStore,
  profile: MiniMaxProviderProfile,
  device: DeviceCodeResponse,
  pkceVerifier: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MiniMaxAuthState> {
  const token = await pollForToken(profile, device, { verifier: pkceVerifier }, opts)
  const expiresUnix = expiredInToUnixSeconds(token.expired_in)
  const state: MiniMaxAuthState = {
    provider_id: profile.id,
    oauth_base_url: profile.oauthBaseUrl,
    inference_base_url: profile.inferenceBaseUrl,
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(expiresUnix * 1000).toISOString(),
    expires_in: Math.max(0, Math.floor(expiresUnix - Date.now() / 1000)),
  }
  await store.write(state)
  return state
}
