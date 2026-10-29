#!/usr/bin/env node
// Smoke test: verify the adapter actually emits `Authorization: Bearer <access_token>`
// against `https://api.minimax.io/anthropic/v1/messages`.
//
// Usage: node tests/smoke.mjs
import { webcrypto as crypto } from 'node:crypto'

const ENV_VAR = 'DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL'

// Use a synthetic but well-formed token; the goal is to capture what the
// adapter *would* send with a real token, not to authenticate successfully.
process.env[ENV_VAR] = JSON.stringify({
  access: 'smoke-test-fake-access-token',
  refresh: 'smoke-test-fake-refresh-token',
  expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  inference_base_url: 'https://api.minimax.io/anthropic',
  oauth_base_url: 'https://account.minimax.io',
})

const lib = await import('../lib/index.mjs')
const { MiniMaxAdapter, MINIMAX_PROVIDER_ID } = lib

let capturedUrl = ''
let capturedMethod = ''
let capturedHeaders = {}
let capturedBody = null

globalThis.fetch = async (url, init) => {
  capturedUrl = url
  capturedMethod = init.method
  capturedHeaders = init.headers
  capturedBody = init.body
  // Simulate a 401 to keep the smoke test offline: we only care about the
  // outbound request shape, not the response body.
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

const adapter = new MiniMaxAdapter({ envVar: ENV_VAR, store: undefined })

try {
  await (async () => {
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } },
      ],
      maxTokens: 256,
      system: 'You are a smoke test.',
    })) {
      // drain
    }
  })()
} catch (err) {
  console.error('stream() rejected (expected for fake token):', String(err).slice(0, 100))
}

console.log('--- captured request ---')
console.log('URL    :', capturedMethod, capturedUrl)
console.log('Auth   :', capturedHeaders.authorization)
console.log('Version:', capturedHeaders['anthropic-version'])
console.log('CT     :', capturedHeaders['content-type'])
console.log('Accept :', capturedHeaders.accept)
console.log('Body   :', capturedBody)

const errors = []
if (capturedUrl !== 'https://api.minimax.io/anthropic/v1/messages') {
  errors.push(`URL wrong: ${capturedUrl}`)
}
if (capturedHeaders.authorization !== 'Bearer smoke-test-fake-access-token') {
  errors.push(`Auth header wrong: ${capturedHeaders.authorization}`)
}
if (capturedHeaders['anthropic-version'] !== '2023-06-01') {
  errors.push(`anthropic-version wrong: ${capturedHeaders['anthropic-version']}`)
}

if (errors.length > 0) {
  console.error('FAIL:')
  for (const e of errors) console.error('  -', e)
  process.exit(1)
}
console.log('\n✓ PASS: request shape matches MiniMax Global OAuth contract.')

delete process.env[ENV_VAR]