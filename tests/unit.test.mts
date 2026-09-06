/**
 * Unit tests for dsh-llm-minimax-oauth.
 *
 * Pure Node test runner (`node --test`) — no extra dependencies.
 * Run with: `node --test tests/`
 *
 * Mock OAuth responses; never exercise real MiniMax credentials.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as crypto } from 'node:crypto'
import {
  generatePkcePair,
  requestDeviceCode,
  expiredInToUnixSeconds,
  runAuthorization,
  type DeviceCodeResponse,
  type PollOptions,
} from '../lib/index.mjs'
import {
  FileCredentialStore,
  resolveAccessToken,
  refreshAccessToken,
  MiniMaxOAuthError,
} from '../lib/index.mjs'

const PROFILE = {
  id: 'minimax',
  label: 'MiniMax (Global)',
  oauthBaseUrl: 'https://account.minimax.io',
  inferenceBaseUrl: 'https://api.minimax.io/anthropic',
}

function mockResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function restoreFetch(mock) {
  if (typeof mock === 'function') {
    globalThis.fetch = mock
  } else {
    delete globalThis.fetch
  }
}

test('PKCE: verifier, challenge, and state are well-formed and distinct', async () => {
  const a = await generatePkcePair()
  const b = await generatePkcePair()

  // Verifier: base64url, ≥ 43 chars (per RFC 7636 §4.1, min 43).
  assert.match(a.verifier, /^[A-Za-z0-9_-]+$/)
  assert.ok(a.verifier.length >= 43, `verifier too short: ${a.verifier.length}`)

  // Challenge: base64url, 43 chars (SHA-256 digest, 32 bytes → 43 base64url chars).
  assert.match(a.challenge, /^[A-Za-z0-9_-]+$/)
  assert.equal(a.challenge.length, 43)

  // State: base64url, 22 chars (16 random bytes).
  assert.match(a.state, /^[A-Za-z0-9_-]+$/)
  assert.equal(a.state.length, 22)

  // Each call returns fresh material.
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.state, b.state)

  // Challenge is SHA-256 of verifier (sanity).
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.verifier))
  const bytes = new Uint8Array(digest)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const expected = Buffer.from(bin, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.equal(a.challenge, expected)
})

test('requestDeviceCode: posts to /oauth2/device/code with PKCE + state', async () => {
  const pkce = await generatePkcePair()
  let captured = null
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return mockResponse(200, {
      user_code: 'ABCD-1234',
      verification_uri: 'https://account.minimax.io/oauth-authorize',
      verification_url: 'https://account.minimax.io/oauth-authorize',
      expired_in: Date.now() + 600_000,
      interval: 2000,
      state: pkce.state,
    })
  }
  try {
    const device = await requestDeviceCode(PROFILE, pkce)
    assert.equal(device.user_code, 'ABCD-1234')
    assert.equal(device.verification_uri, 'https://account.minimax.io/oauth-authorize')
    assert.equal(captured.url, 'https://account.minimax.io/oauth2/device/code')
    assert.equal(captured.init.method, 'POST')
    assert.equal(captured.init.headers['Content-Type'], 'application/x-www-form-urlencoded')
    const body = new URLSearchParams(captured.init.body)
    assert.equal(body.get('response_type'), 'code')
    assert.equal(body.get('client_id'), '78257093-7e40-4613-99e0-527b14b39113')
    assert.equal(body.get('scope'), 'group_id profile model.completion')
    assert.equal(body.get('code_challenge'), pkce.challenge)
    assert.equal(body.get('code_challenge_method'), 'S256')
    assert.equal(body.get('state'), pkce.state)
  } finally {
    restoreFetch(original)
  }
})

test('requestDeviceCode: rejects state mismatch', async () => {
  const pkce = await generatePkcePair()
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    mockResponse(200, {
      user_code: 'X',
      verification_uri: 'https://account.minimax.io/oauth-authorize',
      expired_in: Date.now() + 600_000,
      state: 'different-from-request',
    })
  try {
    await assert.rejects(
      () => requestDeviceCode(PROFILE, pkce),
      (err) => err instanceof MiniMaxOAuthError && err.code === 'state_mismatch',
    )
  } finally {
    restoreFetch(original)
  }
})

test('requestDeviceCode: rejects missing required fields', async () => {
  const pkce = await generatePkcePair()
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    mockResponse(200, { state: pkce.state })
  try {
    await assert.rejects(
      () => requestDeviceCode(PROFILE, pkce),
      (err) => err instanceof MiniMaxOAuthError && err.code === 'authorization_incomplete',
    )
  } finally {
    restoreFetch(original)
  }
})

test('expiredInToUnixSeconds: TTL seconds vs absolute millis', () => {
  // TTL seconds (small value) → now + TTL.
  const ttl = expiredInToUnixSeconds(3600)
  const expected = Math.floor(Date.now() / 1000) + 3600
  assert.ok(Math.abs(ttl - expected) < 5, `ttl=${ttl} expected≈${expected}`)

  // Absolute millis (large value, future) → treat as ms.
  const futureMs = Date.now() + 3600_000
  const fromMs = expiredInToUnixSeconds(futureMs)
  assert.ok(Math.abs(fromMs - futureMs / 1000) < 5)
})

test('FileCredentialStore: round-trip and clear', async () => {
  const tmp = `/tmp/minimax-oauth-test-${process.pid}-${Date.now()}.json`
  const store = new FileCredentialStore(tmp)
  try {
    assert.equal(await store.read('minimax'), undefined)
    assert.deepEqual(await store.list(), [])

    const state = {
      provider_id: 'minimax',
      oauth_base_url: 'https://account.minimax.io',
      inference_base_url: 'https://api.minimax.io/anthropic',
      client_id: '78257093-7e40-4613-99e0-527b14b39113',
      access_token: 'access-AAA',
      refresh_token: 'refresh-BBB',
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
    }
    await store.write(state)
    const round = await store.read('minimax')
    assert.equal(round.access_token, 'access-AAA')
    assert.equal(round.refresh_token, 'refresh-BBB')
    assert.deepEqual(await store.list(), [round])

    await store.clear('minimax')
    assert.equal(await store.read('minimax'), undefined)
    assert.deepEqual(await store.list(), [])
  } finally {
    await import('node:fs/promises').then((fs) => fs.unlink(tmp).catch(() => {}))
  }
})

test('resolveAccessToken: returns access_token when not near expiry', async () => {
  const tmp = `/tmp/minimax-oauth-test-${process.pid}-${Date.now()}-fresh.json`
  const store = new FileCredentialStore(tmp)
  try {
    await store.write({
      provider_id: 'minimax',
      oauth_base_url: 'https://account.minimax.io',
      inference_base_url: 'https://api.minimax.io/anthropic',
      client_id: '78257093-7e40-4613-99e0-527b14b39113',
      access_token: 'fresh-token',
      refresh_token: 'refresh',
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
    })
    const token = await resolveAccessToken(store, PROFILE)
    assert.equal(token, 'fresh-token')
  } finally {
    await import('node:fs/promises').then((fs) => fs.unlink(tmp).catch(() => {}))
  }
})

test('resolveAccessToken: throws when not logged in', async () => {
  const tmp = `/tmp/minimax-oauth-test-${process.pid}-${Date.now()}-none.json`
  const store = new FileCredentialStore(tmp)
  try {
    await assert.rejects(
      () => resolveAccessToken(store, PROFILE),
      (err) => err instanceof MiniMaxOAuthError && err.code === 'not_logged_in',
    )
  } finally {
    await import('node:fs/promises').then((fs) => fs.unlink(tmp).catch(() => {}))
  }
})

test('resolveAccessToken: refreshes when within skew', async () => {
  const tmp = `/tmp/minimax-oauth-test-${process.pid}-${Date.now()}-skew.json`
  const store = new FileCredentialStore(tmp)
  const original = globalThis.fetch
  try {
    await store.write({
      provider_id: 'minimax',
      oauth_base_url: 'https://account.minimax.io',
      inference_base_url: 'https://api.minimax.io/anthropic',
      client_id: '78257093-7e40-4613-99e0-527b14b39113',
      access_token: 'stale-token',
      refresh_token: 'refresh-stale',
      obtained_at: new Date().toISOString(),
      // Within 60s of now → triggers refresh.
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      expires_in: 30,
    })
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://account.minimax.io/oauth2/token')
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('grant_type'), 'refresh_token')
      assert.equal(body.get('refresh_token'), 'refresh-stale')
      return mockResponse(200, {
        access_token: 'fresh-after-refresh',
        refresh_token: 'refresh-new',
        expired_in: 3600_000,
        status: 'success',
      })
    }
    const token = await resolveAccessToken(store, PROFILE)
    assert.equal(token, 'fresh-after-refresh')
    const persisted = await store.read('minimax')
    assert.equal(persisted.access_token, 'fresh-after-refresh')
    assert.equal(persisted.refresh_token, 'refresh-new')
  } finally {
    restoreFetch(original)
    await import('node:fs/promises').then((fs) => fs.unlink(tmp).catch(() => {}))
  }
})

test('refreshAccessToken: invalid_grant sets reloginRequired', async () => {
  const tmp = `/tmp/minimax-oauth-test-${process.pid}-${Date.now()}-relogin.json`
  const store = new FileCredentialStore(tmp)
  const original = globalThis.fetch
  try {
    const state = {
      provider_id: 'minimax',
      oauth_base_url: 'https://account.minimax.io',
      inference_base_url: 'https://api.minimax.io/anthropic',
      client_id: '78257093-7e40-4613-99e0-527b14b39113',
      access_token: 'old',
      refresh_token: 'refresh-old',
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
      expires_in: -1,
    }
    globalThis.fetch = async () =>
      mockResponse(400, '{"error":"invalid_grant","error_description":"expired"}')
    await assert.rejects(
      () => refreshAccessToken(store, PROFILE, state),
      (err) => err instanceof MiniMaxOAuthError && err.code === 'refresh_failed' && err.reloginRequired === true,
    )
  } finally {
    restoreFetch(original)
    await import('node:fs/promises').then((fs) => fs.unlink(tmp).catch(() => {}))
  }
})