/**
 * Tests for the MiniMax OAuth adapter.
 *
 * The adapter speaks the Anthropic Messages wire format directly, so the
 * tests assert on the actual HTTP request shape (header + body) using a
 * stubbed `fetch`, then drive the resulting SSE stream through the harness
 * `StreamChunk` protocol. The tests never hit a real MiniMax endpoint and
 * never use a real OAuth token.
 *
 * Harness vocabulary exercised here (DSH `0.2.1-rc.3`):
 *   - `GenerateOptions.messages` is a role-tagged union: a system prompt
 *     arrives as a leading `role: 'system'` message, a tool result as its own
 *     `role: 'tool'` message, and tool-change blocks as a `role: 'developer'`
 *     message.
 *   - Tool-call correlation is branded as `ToolCallId`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MiniMaxAdapter,
  readSerializedToken,
  DEFAULT_PROVIDER_PROFILES,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_PROVIDER_ID,
  MessageId,
  ToolCallId,
} from '../lib/index.mjs'

function makeValidToken(overrides = {}) {
  return {
    access: 'test-access-token-123',
    refresh: 'test-refresh-token-456',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    inference_base_url: 'https://api.minimax.io/anthropic',
    oauth_base_url: 'https://account.minimax.io',
    ...overrides,
  }
}

function sseResponse(chunks) {
  const body = chunks.join('\n\n') + '\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-test-1' },
  })
}

function makeAdapter(envVar) {
  return new MiniMaxAdapter({ envVar, store: undefined })
}

/** One user-role message carrying plain text. */
function userMessage(text) {
  return {
    id: MessageId('m-user'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** One leading system-role message, the `0.2.x` system-prompt carrier. */
function systemMessage(text) {
  return {
    id: MessageId('m-system'),
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  }
}

/** One tool-role message answering a tool call. */
function toolMessage(callId, text, isError = false) {
  return {
    id: MessageId('m-tool'),
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    ...(isError ? { isError: true } : {}),
  }
}

test('adapter: providerInfo returns OAuth label', () => {
  const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
  const info = adapter.providerInfo(MINIMAX_PROVIDER_ID)
  assert.equal(info.id, MINIMAX_PROVIDER_ID)
  assert.equal(info.name, 'MiniMax (OAuth)')
})

test('adapter: listModels exposes M3, M3.1-Flash, M2.7, M2.7-highspeed', async () => {
  const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
  const models = await adapter.listModels(MINIMAX_PROVIDER_ID)
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('MiniMax-M3'), `M3 missing in ${ids.join(',')}`)
  assert.ok(ids.includes('MiniMax-M3.1-Flash'))
  assert.ok(ids.includes('MiniMax-M2.7'))
  assert.ok(ids.includes('MiniMax-M2.7-highspeed'))
  // The route serializes text only, so it must declare that modality.
  for (const model of models) {
    assert.deepEqual(model.inputModalities, ['text'], `${model.id} must declare text-only input`)
  }
})

test('adapter: resolveModel returns 1M context for M3', async () => {
  const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
  const info = await adapter.resolveModel(MINIMAX_PROVIDER_ID, 'MiniMax-M3')
  assert.equal(info.id, 'MiniMax-M3')
  assert.equal(info.context?.contextWindow, 1_000_000)
  assert.equal(info.defaultMaxTokens, 524_288)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('readSerializedToken: parses a valid envelope', () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)
  try {
    const parsed = readSerializedToken(MINIMAX_INFERENCE_ENV_VAR)
    assert.ok(parsed !== undefined)
    assert.equal(parsed.access, token.access)
    assert.equal(parsed.refresh, token.refresh)
    assert.equal(parsed.expires_at, token.expires_at)
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  }
})

test('readSerializedToken: returns undefined for missing or malformed input', () => {
  delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  assert.equal(readSerializedToken(MINIMAX_INFERENCE_ENV_VAR), undefined)
  process.env[MINIMAX_INFERENCE_ENV_VAR] = 'not-json'
  assert.equal(readSerializedToken(MINIMAX_INFERENCE_ENV_VAR), undefined)
  delete process.env[MINIMAX_INFERENCE_ENV_VAR]
})

test('adapter: stream() emits Authorization: Bearer with the access token', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedUrl = ''
  let capturedHeaders = {}
  let capturedBody = null

  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedHeaders = init.headers
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [userMessage('hi')],
      maxTokens: 1024,
    })) {
      chunks.push(chunk)
    }

    assert.equal(capturedUrl, 'https://api.minimax.io/anthropic/v1/messages')
    assert.equal(capturedHeaders.authorization, `Bearer ${token.access}`)
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01')
    assert.equal(capturedHeaders['content-type'], 'application/json')
    assert.equal(capturedHeaders.accept, 'text/event-stream')
    assert.equal(capturedBody.model, 'MiniMax-M3')
    assert.equal(capturedBody.stream, true)
    assert.equal(capturedBody.max_tokens, 1024)
    assert.deepEqual(capturedBody.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])

    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish !== undefined, 'expected a finish chunk')
    assert.equal(finish.reason.kind, 'stop')

    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage !== undefined, 'expected a usage chunk')
    assert.equal(usage.usage.inputTokens, 3)
    assert.equal(usage.usage.outputTokens, 1)
    // The Anthropic wire format reports no total, so the adapter derives it.
    assert.equal(usage.usage.totalTokens, 4)
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() lifts the leading system message into the system slot', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [systemMessage('You are terse.'), userMessage('hi')],
    })) {
      // drain
    }
    assert.equal(capturedBody.system, 'You are terse.')
    // The system message must not also stay in the conversation history.
    assert.deepEqual(capturedBody.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() merges the request-level system prompt with the system message', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [systemMessage('Second part.')],
      system: 'First part.',
    })) {
      // drain
    }
    assert.equal(capturedBody.system, 'First part.\n\nSecond part.')
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() serializes a tool-role message into an Anthropic tool_result', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [
        userMessage('weather?'),
        {
          id: MessageId('m-assistant'),
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: ToolCallId('toolu_1'),
            name: 'get_weather',
            arguments: '{"city":"Jakarta"}',
          }],
          source: { kind: 'model', provider: MINIMAX_PROVIDER_ID, model: 'MiniMax-M3' },
        },
        toolMessage('toolu_1', 'sunny, 31C'),
      ],
    })) {
      // drain
    }
    assert.deepEqual(capturedBody.messages, [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_weather',
          input: { city: 'Jakarta' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'sunny, 31C' }],
        }],
      },
    ])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() marks a failed tool result with is_error', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [toolMessage('toolu_9', 'boom', true)],
    })) {
      // drain
    }
    assert.deepEqual(capturedBody.messages, [
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_9',
          content: [{ type: 'text', text: 'boom' }],
          is_error: true,
        }],
      },
    ])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() drops developer tool-change messages (complete tool list is sent)', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [
        {
          id: MessageId('m-dev'),
          role: 'developer',
          content: [{ type: 'tool-addition', toolName: 'get_weather' }],
          source: { kind: 'user' },
        },
        userMessage('hi'),
      ],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    })) {
      // drain
    }
    assert.deepEqual(capturedBody.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    // The tool declaration still rides on the request.
    assert.deepEqual(capturedBody.tools, [{
      name: 'get_weather',
      description: 'Get current weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() sends tools in Anthropic format when present', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
      tools: [
        { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      ],
    })) {
      chunks.push(chunk)
    }
    assert.deepEqual(capturedBody.tools, [
      {
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() omits deferred tool declarations', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
      tools: [
        { name: 'deferred_tool', description: 'Loaded on demand', parameters: {}, deferLoading: true },
        { name: 'eager_tool', description: 'Always sent', parameters: {} },
      ],
    })) {
      // drain
    }
    assert.deepEqual(capturedBody.tools?.map((t) => t.name), ['eager_tool'])
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() maps tool_use stream into a tool-call block', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  globalThis.fetch = async (_url, _init) => sseResponse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Jakarta\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ])

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    const blocks = []
    let finish
    for await (const chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
    })) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk
    }
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'tool-call')
    assert.equal(blocks[0].name, 'get_weather')
    assert.equal(blocks[0].id, 'toolu_1')
    assert.equal(blocks[0].arguments, '{"city":"Jakarta"}')
    assert.equal(finish.reason.kind, 'tool-calls')
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() raises LlmError when token env var is unset', async () => {
  delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: MINIMAX_PROVIDER_ID,
        model: 'MiniMax-M3',
        messages: [],
      })) {
        // drain
      }
    },
    /MISSING_CREDENTIAL|No MiniMax OAuth token/,
  )
})

test('adapter: stream() raises LlmError on 401', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)
  globalThis.fetch = async () =>
    new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream({
          provider: MINIMAX_PROVIDER_ID,
          model: 'MiniMax-M3',
          messages: [],
        })) {
          // drain
        }
      },
      /AUTH|401|unauthorized/,
    )
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() refreshes token inline when within skew', async () => {
  // 30s remaining < 60s skew, should refresh.
  const token = makeValidToken({
    expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
    refresh: 'old-refresh',
  })
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)

  let refreshCalls = 0
  let capturedAuth = ''
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    if (u.pathname === '/oauth2/token') {
      refreshCalls += 1
      return new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expired_in: 3600 * 1000,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    capturedAuth = init.headers.authorization
    return sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_4","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ])
  }

  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    for await (const _chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
    })) {
      // drain
    }
    assert.equal(refreshCalls, 1)
    assert.equal(capturedAuth, 'Bearer fresh-access')
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: stream() rejects when provider id does not match', async () => {
  const token = makeValidToken()
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(token)
  try {
    const adapter = makeAdapter(MINIMAX_INFERENCE_ENV_VAR)
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream({
          provider: 'some-other-provider',
          model: 'MiniMax-M3',
          messages: [],
        })) {
          // drain
        }
      },
      /unexpected provider/,
    )
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  }
})

test('DEFAULT_PROVIDER_PROFILES: single global profile with correct endpoints', () => {
  assert.equal(DEFAULT_PROVIDER_PROFILES.length, 1)
  const profile = DEFAULT_PROVIDER_PROFILES[0]
  assert.equal(profile.oauthBaseUrl, 'https://account.minimax.io')
  assert.equal(profile.inferenceBaseUrl, 'https://api.minimax.io/anthropic')
})
