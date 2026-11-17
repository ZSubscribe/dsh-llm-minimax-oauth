/**
 * Regression tests for the MiniMax adapter's failure reporting.
 *
 * The harness re-raises an in-band failure through `LlmError.fromFailure`,
 * whose constructor rejects an empty failure code outright. A raw provider
 * stop reason used as the code therefore crashed the whole turn with
 * "LlmError code must be a non-empty string". These tests pin the contract
 * that keeps every failure code a non-empty built-in code, and that a
 * truncated stream is reported instead of silently ending the turn.
 *
 * The adapter speaks the Anthropic Messages wire format, so the tests drive
 * it with a stubbed `fetch` that returns a stubbed SSE response. They never
 * hit a real MiniMax endpoint and never use a real OAuth token.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MiniMaxAdapter,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_PROVIDER_ID,
} from '../lib/index.mjs'

/** One valid token envelope for the adapter to resolve. */
function makeValidToken() {
  return {
    access: 'test-access-token-123',
    refresh: 'test-refresh-token-456',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    inference_base_url: 'https://api.minimax.io/anthropic',
    oauth_base_url: 'https://account.minimax.io',
  }
}

/** Build one SSE event from an event name and a JSON payload. */
function sseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}`
}

/** Build one SSE response body from already-rendered event blocks. */
function sseResponse(chunks) {
  return new Response(chunks.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-test-1' },
  })
}

/** The `message_start` event every provider stream opens with. */
function messageStart(id) {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'MiniMax-M3',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
}

/** The `message_delta` event that carries the provider's stop reason. */
function messageDelta(stopReason) {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 0 },
  })
}

/** The terminal `message_stop` event. */
function messageStop() {
  return sseEvent('message_stop', { type: 'message_stop' })
}

/** One adapter over the given provider events. */
function makeAdapter() {
  return new MiniMaxAdapter({ envVar: MINIMAX_INFERENCE_ENV_VAR, store: undefined })
}

/** Install a stubbed provider response for the next request. */
function stubProvider(chunks) {
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(makeValidToken())
  globalThis.fetch = async () => sseResponse(chunks)
}

/** Remove the stubbed provider and the stubbed token. */
function clearProvider() {
  delete process.env[MINIMAX_INFERENCE_ENV_VAR]
  delete globalThis.fetch
}

/** Run one adapter stream over the stubbed provider and collect its chunks. */
async function streamOver(chunks) {
  stubProvider(chunks)
  try {
    const collected = []
    for await (const chunk of makeAdapter().stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
    })) {
      collected.push(chunk)
    }
    return collected
  } finally {
    clearProvider()
  }
}

/** Run one adapter stream over the stubbed provider and collect its finish chunk. */
async function finishOver(chunks) {
  const collected = await streamOver(chunks)
  const finish = collected.find((chunk) => chunk.type === 'finish')
  assert.ok(finish !== undefined, 'the stream must end with a finish chunk')
  return finish
}

test('adapter: an empty stop reason yields a built-in failure code, never an empty one', async () => {
  const finish = await finishOver([
    messageStart('msg-empty'),
    messageDelta(''),
    messageStop(),
  ])
  assert.equal(finish.reason.kind, 'error')
  const failure = finish.reason.failure
  assert.equal(typeof failure.code, 'string')
  assert.notEqual(failure.code.trim(), '')
  assert.equal(failure.code, 'INVALID_RESPONSE')
  // The raw reason stays readable in the message even though it is gone as a code.
  assert.match(failure.message, /unexpected stop reason/)
})

test('adapter: an unknown stop reason keeps the reason in the message and uses a built-in code', async () => {
  const finish = await finishOver([
    messageStart('msg-unknown'),
    messageDelta('some_future_reason'),
    messageStop(),
  ])
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'INVALID_RESPONSE')
  assert.match(finish.reason.failure.message, /some_future_reason/)
})

test('adapter: a refusal stop reason maps onto a built-in content code', async () => {
  const finish = await finishOver([
    messageStart('msg-refusal'),
    messageDelta('refusal'),
    messageStop(),
  ])
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'UNSUPPORTED_CONTENT')
})

test('adapter: a context-window stop reason maps onto the host overflow code', async () => {
  const finish = await finishOver([
    messageStart('msg-context'),
    messageDelta('model_context_window_exceeded'),
    messageStop(),
  ])
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('adapter: a stream that ends without a terminal event reports a retryable failure', async () => {
  const finish = await finishOver([
    messageStart('msg-truncated'),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'partial' },
    }),
  ])
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'STREAM_CLOSED')
})

test('adapter: tool arguments delivered only in the start event are not lost', async () => {
  const collected = await streamOver([
    messageStart('msg-tool-input'),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_start_input',
        name: 'get_weather',
        input: { city: 'Jakarta' },
      },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageDelta('tool_use'),
    messageStop(),
  ])
  const blocks = collected.filter((chunk) => chunk.type === 'block-end')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].block.type, 'tool-call')
  assert.equal(blocks[0].block.arguments, '{"city":"Jakarta"}')
})

test('adapter: malformed tool arguments are rejected with a built-in code', async () => {
  stubProvider([
    messageStart('msg-bad-args'),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_bad', name: 'get_weather', input: {} },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageStop(),
  ])
  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of makeAdapter().stream({
          provider: MINIMAX_PROVIDER_ID,
          model: 'MiniMax-M3',
          messages: [],
        })) {
          // drain
        }
      },
      (error) => {
        assert.equal(error.code, 'MALFORMED_RESPONSE')
        assert.match(error.message, /invalid JSON arguments/)
        return true
      },
    )
  } finally {
    clearProvider()
  }
})

test('adapter: provider error types map onto retryable built-in codes', async () => {
  stubProvider([
    sseEvent('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'upstream is busy' },
    }),
  ])
  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of makeAdapter().stream({
          provider: MINIMAX_PROVIDER_ID,
          model: 'MiniMax-M3',
          messages: [],
        })) {
          // drain
        }
      },
      (error) => {
        assert.equal(error.code, 'SERVER')
        assert.match(error.message, /upstream is busy/)
        return true
      },
    )
  } finally {
    clearProvider()
  }
})

test('adapter: the retry policy repeats a truncated stream', () => {
  const policy = makeAdapter().providerRetryPolicy(MINIMAX_PROVIDER_ID)
  assert.ok(policy !== undefined)
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.retryableCodes.includes('STREAM_CLOSED'))
  assert.ok(policy.retryableCodes.includes('TRANSPORT'))
})
