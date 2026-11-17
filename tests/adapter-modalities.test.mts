/**
 * Tests for the MiniMax adapter's non-text modalities.
 *
 * Two capabilities are pinned here:
 *
 *   - Images. MiniMax's M3 line accepts base64 images, so the route reads the
 *     bytes through the host's attachment service and sends them as Anthropic
 *     image parts. A request whose images exceed the route's budget fails with
 *     `IMAGE_OFFLOAD_REQUIRED` instead of silently dropping a picture.
 *   - Thinking. MiniMax emits its reasoning as a `thinking` block with a
 *     signature. The route surfaces that as the harness' reasoning block and
 *     stores the signature in the replay envelope, so the next request can
 *     replay the thinking chain the provider signed.
 *
 * The adapter speaks the Anthropic Messages wire format, so the tests drive it
 * with a stubbed `fetch` that returns a stubbed SSE response. They never hit a
 * real MiniMax endpoint and never use a real OAuth token.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MiniMaxAdapter,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_PROVIDER_ID,
  MessageId,
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
    headers: { 'content-type': 'text/event-stream' },
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
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  })
}

/** The terminal `message_stop` event. */
function messageStop() {
  return sseEvent('message_stop', { type: 'message_stop' })
}

/** One image attachment reference. */
function imageRef(overrides = {}) {
  return {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 12,
    width: 4,
    height: 4,
    ...overrides,
  }
}

/** One user-role message carrying an image block. */
function imageUserMessage(ref = imageRef()) {
  return {
    id: MessageId('m-user'),
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  }
}

/** One attachment service that serves a fixed image. */
function makeAttachments(bytes = 12) {
  const calls = []
  return {
    calls,
    store: {
      async readImageRequest(ref, target) {
        calls.push({ ref, target })
        return {
          data: new Uint8Array(bytes),
          mediaType: ref.mediaType,
          bytes,
          width: target.width,
          height: target.height,
        }
      },
    },
  }
}

/**
 * Run one adapter stream over a stubbed provider and collect the chunks and
 * the request body the adapter sent.
 */
async function streamOver(chunks, options = {}) {
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(makeValidToken())
  let capturedBody = null
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return sseResponse(chunks)
  }
  try {
    const adapter = new MiniMaxAdapter({
      envVar: MINIMAX_INFERENCE_ENV_VAR,
      store: undefined,
      ...options,
    })
    const collected = []
    for await (const chunk of adapter.stream({
      provider: MINIMAX_PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [],
      ...options.generateOptions,
    })) {
      collected.push(chunk)
    }
    return { chunks: collected, body: capturedBody }
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
}

test('adapter: a request with an image asks the attachment service for the bytes', async () => {
  const attachments = makeAttachments()
  const { body } = await streamOver(
    [messageStart('msg-1'), messageStop()],
    {
      resolveAttachments: () => attachments.store,
      generateOptions: { messages: [imageUserMessage()] },
    },
  )
  assert.equal(attachments.calls.length, 1, 'the image must be read exactly once')
  assert.equal(attachments.calls[0].ref.attachmentId, 'att-1')
  const parts = body.messages[0].content
  const image = parts.find((part) => part.type === 'image')
  assert.ok(image !== undefined, 'the wire body must carry the image part')
  assert.equal(image.source.type, 'base64')
  assert.equal(image.source.media_type, 'image/png')
  assert.equal(image.source.data, Buffer.from(new Uint8Array(12)).toString('base64'))
  // The handle text names the image so the model can refer to it.
  const handle = parts.find((part) => part.type === 'text' && part.text.includes('request preview'))
  assert.ok(handle !== undefined, 'the image needs a handle text')
})

test('adapter: an image request asks for the route image target', async () => {
  const attachments = makeAttachments()
  await streamOver(
    [messageStart('msg-1'), messageStop()],
    {
      resolveAttachments: () => attachments.store,
      generateOptions: { messages: [imageUserMessage(imageRef({ width: 8192, height: 8192 }))] },
    },
  )
  const target = attachments.calls[0].target
  assert.ok(target.width <= 2048, 'the requested width must fit the pixel budget')
  assert.ok(target.height <= 2048, 'the requested height must fit the pixel budget')
  assert.ok(target.maxBytes > 0, 'the request must state a byte target')
})

test('adapter: a request without an attachment service reports an unsupported image', async () => {
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(makeValidToken())
  globalThis.fetch = async () => sseResponse([messageStart('msg-1'), messageStop()])
  try {
    const adapter = new MiniMaxAdapter({ envVar: MINIMAX_INFERENCE_ENV_VAR, store: undefined })
    const collected = []
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({
        provider: MINIMAX_PROVIDER_ID,
        model: 'MiniMax-M3',
        messages: [imageUserMessage()],
      })) {
        collected.push(chunk)
      }
    }, (error) => {
      assert.equal(error.code, 'UNSUPPORTED_CONTENT')
      return true
    })
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: a request that exceeds the image budget asks the surface to offload', async () => {
  const attachments = makeAttachments()
  // 51 occurrences exceed the route budget of 50 images per request.
  const messages = []
  for (let index = 0; index < 51; index += 1) {
    messages.push(imageUserMessage(imageRef({ attachmentId: `att-${index}` })))
  }
  process.env[MINIMAX_INFERENCE_ENV_VAR] = JSON.stringify(makeValidToken())
  globalThis.fetch = async () => sseResponse([messageStart('msg-1'), messageStop()])
  try {
    const adapter = new MiniMaxAdapter({
      envVar: MINIMAX_INFERENCE_ENV_VAR,
      store: undefined,
      resolveAttachments: () => attachments.store,
    })
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({
        provider: MINIMAX_PROVIDER_ID,
        model: 'MiniMax-M3',
        messages,
      })) {
        void chunk
      }
    }, (error) => {
      assert.equal(error.code, 'IMAGE_OFFLOAD_REQUIRED')
      assert.equal(error.failure.offloadImages, 1)
      return true
    })
  } finally {
    delete process.env[MINIMAX_INFERENCE_ENV_VAR]
    delete globalThis.fetch
  }
})

test('adapter: a thinking block becomes a reasoning block with its signature', async () => {
  const { chunks } = await streamOver([
    messageStart('msg-1'),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think.' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-abc' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Hello.' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 12, output_tokens_details: { thinking_tokens: 5 } },
    }),
    messageStop(),
  ])

  const start = chunks.find((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning')
  assert.ok(start !== undefined, 'the reasoning block must start')
  const delta = chunks.find((chunk) => chunk.type === 'reasoning-delta')
  assert.ok(delta !== undefined, 'the reasoning text must arrive as a reasoning delta')
  assert.equal(delta.text, 'Let me think.')
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.ok(end !== undefined, 'the reasoning block must end')
  assert.equal(end.block.text, 'Let me think.')

  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.ok(usage !== undefined, 'the stream must report usage')
  assert.equal(usage.usage.reasoningTokens, 5)

  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.ok(finish !== undefined)
  assert.equal(finish.replayState.response.kind, 'minimax-anthropic')
  assert.equal(finish.replayState.blocks.length, 2, 'one replay entry per emitted block')
  assert.equal(finish.replayState.blocks[0].type, 'reasoning')
  assert.equal(finish.replayState.blocks[0].thinkingSignature, 'sig-abc')
  assert.equal(finish.replayState.blocks[1].type, 'text')
})

test('adapter: the request always asks for adaptive thinking', async () => {
  const { body } = await streamOver([messageStart('msg-1'), messageStop()])
  assert.deepEqual(body.thinking, { type: 'adaptive' })
})

test('adapter: a selected reasoning effort is sent as the output config', async () => {
  const { body } = await streamOver([messageStart('msg-1'), messageStop()], {
    generateOptions: { messages: [], reasoningEffort: 'high' },
  })
  assert.deepEqual(body.output_config, { effort: 'high' })
})

test('adapter: an unsupported reasoning effort is dropped instead of rejected', async () => {
  const { body } = await streamOver([messageStart('msg-1'), messageStop()], {
    generateOptions: { messages: [], reasoningEffort: 'bogus' },
  })
  assert.equal(body.output_config, undefined)
})

test('adapter: a replayed thinking block keeps its signature on the wire', async () => {
  const { body } = await streamOver([messageStart('msg-1'), messageStop()], {
    generateOptions: {
      messages: [
        {
          id: MessageId('m-assistant'),
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'Earlier thought.' }],
          source: {
            kind: 'model',
            provider: MINIMAX_PROVIDER_ID,
            model: 'MiniMax-M3',
            replayState: {
              response: {
                kind: 'minimax-anthropic',
                version: 1,
                provider: MINIMAX_PROVIDER_ID,
                model: 'MiniMax-M3',
              },
              blocks: [{ type: 'reasoning', thinkingSignature: 'sig-xyz' }],
            },
          },
        },
      ],
    },
  })
  const part = body.messages[0].content[0]
  assert.equal(part.type, 'thinking')
  assert.equal(part.thinking, 'Earlier thought.')
  assert.equal(part.signature, 'sig-xyz')
})

test('adapter: a reasoning block without a signature travels as plain text', async () => {
  const { body } = await streamOver([messageStart('msg-1'), messageStop()], {
    generateOptions: {
      messages: [
        {
          id: MessageId('m-assistant'),
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'Earlier thought.' }],
          source: {
            kind: 'model',
            provider: MINIMAX_PROVIDER_ID,
            model: 'MiniMax-M3',
          },
        },
      ],
    },
  })
  const part = body.messages[0].content[0]
  assert.equal(part.type, 'text')
  assert.equal(part.text, 'Earlier thought.')
})
