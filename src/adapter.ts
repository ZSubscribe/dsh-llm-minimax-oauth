/**
 * Custom `LlmAdapter` for MiniMax Global OAuth.
 *
 * The built-in `pi-ai` `anthropic-messages` API sends the credential as
 * `x-api-key`, which is correct for first-party Anthropic and for MiniMax's
 * API-key path but wrong for the OAuth/Coding-Plan path. MiniMax's OAuth
 * backend authenticates the request with `Authorization: Bearer <access_token>`
 * and rejects requests that arrive under the `x-api-key` header.
 *
 * This adapter speaks the Anthropic Messages wire format directly so the
 * credential leaves the harness through the OAuth-authenticated header while
 * the rest of the request body, the SSE parsing, and the harness
 * `StreamChunk` vocabulary stay identical to a first-party Anthropic client.
 *
 * Token resolution reads the serialized JSON token from
 * `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL`. The token envelope holds the
 * OAuth access token, refresh token, expiry, and the inference base URL; an
 * inline refresh swaps in a fresh access token when the cached one is within
 * {@link MINIMAX_OAUTH_REFRESH_SKEW_SECONDS} of expiry.
 *
 * @module dsh-llm-minimax-oauth/adapter
 */

import {
  CallId,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  MINIMAX_DEFAULT_MAX_TOKENS,
  MINIMAX_DEFAULT_CONTEXT_WINDOW,
  MINIMAX_DEFAULT_MODEL_CATALOG,
  MINIMAX_INFERENCE_ENV_VAR,
  MINIMAX_OAUTH_REFRESH_GRANT,
  MINIMAX_OAUTH_REFRESH_SKEW_SECONDS,
  MINIMAX_PROVIDER_ID,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS,
  MINIMAX_ANTHROPIC_VERSION,
} from './const.ts'
import { FileCredentialStore, MiniMaxOAuthError } from './store.ts'

/** Serialized token envelope written to the inference env var. */
export interface SerializedToken {
  access: string
  refresh: string
  expires_at: string
  inference_base_url: string
  oauth_base_url: string
}

/**
 * Resolve and validate the OAuth token envelope from the env var.
 *
 * The env var is the seam between OAuth login (which writes it) and the
 * adapter (which reads it). Parsing it here keeps both halves free of any
 * shared mutable state and keeps the adapter usable from any process that
 * inherits the env — useful for `tsdown`-bundled bins and for the runtime.
 */
export function readSerializedToken(envVar: string): SerializedToken | undefined {
  const raw = process.env[envVar]
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedToken>
    if (
      typeof parsed.access !== 'string' || parsed.access.length === 0
      || typeof parsed.refresh !== 'string'
      || typeof parsed.expires_at !== 'string'
      || typeof parsed.inference_base_url !== 'string'
      || typeof parsed.oauth_base_url !== 'string'
    ) {
      return undefined
    }
    return parsed as SerializedToken
  } catch {
    return undefined
  }
}

/** True when the access token is within the refresh skew of expiry. */
function needsRefresh(token: SerializedToken, now = Date.now()): boolean {
  const expiresAt = Date.parse(token.expires_at)
  if (!Number.isFinite(expiresAt)) return true
  return now + MINIMAX_OAUTH_REFRESH_SKEW_SECONDS * 1000 >= expiresAt
}

/**
 * Refresh the OAuth access token and return a fresh envelope.
 *
 * The refresh path is shared by both the runtime adapter and the persisted
 * store: the runtime writes back the new envelope into the env var so the
 * next request reuses it, and the store writes the same data to disk so the
 * login survives a restart.
 */
async function refreshToken(token: SerializedToken): Promise<SerializedToken> {
  const form = new URLSearchParams({
    grant_type: MINIMAX_OAUTH_REFRESH_GRANT,
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    refresh_token: token.refresh,
  })
  const res = await fetch(`${token.oauth_base_url}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new MiniMaxOAuthError(
      `MiniMax OAuth refresh failed (HTTP ${res.status}): ${body || res.statusText}`,
      'refresh_failed',
    )
  }
  const payload = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expired_in?: number
  }
  if (!payload.access_token) {
    throw new MiniMaxOAuthError('MiniMax OAuth refresh missing access_token', 'token_incomplete')
  }
  const expiredInMs = payload.expired_in ?? 0
  const next: SerializedToken = {
    access: payload.access_token,
    refresh: payload.refresh_token || token.refresh,
    expires_at: new Date(Date.now() + expiredInMs).toISOString(),
    inference_base_url: token.inference_base_url,
    oauth_base_url: token.oauth_base_url,
  }
  return next
}

/** Persist the envelope back to the env var and the optional on-disk store. */
function writeTokenBack(envVar: string, token: SerializedToken, store?: FileCredentialStore): void {
  process.env[envVar] = JSON.stringify(token)
  if (store !== undefined) {
    // Best-effort write; the in-process env var already has the fresh value
    // and a subsequent boot re-reads from disk, so a write failure does not
    // invalidate the live session.
    void store.write({
      provider_id: MINIMAX_PROVIDER_ID,
      oauth_base_url: token.oauth_base_url,
      inference_base_url: token.inference_base_url,
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      access_token: token.access,
      refresh_token: token.refresh,
      obtained_at: new Date().toISOString(),
      expires_at: token.expires_at,
      expires_in: Math.max(0, Math.floor((Date.parse(token.expires_at) - Date.now()) / 1000)),
    }).catch(() => undefined)
  }
}

/** Anthropic Messages wire `text` part. */
interface AnthropicTextPart {
  type: 'text'
  text: string
}

/** Anthropic Messages wire `image` part (base64 source). */
interface AnthropicImagePart {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

/** Anthropic Messages wire `tool_use` part. */
interface AnthropicToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** Anthropic Messages wire `tool_result` part. */
interface AnthropicToolResultPart {
  type: 'tool_result'
  tool_use_id: string
  content: AnthropicTextPart[] | string
  is_error?: boolean
}

/** Anthropic Messages content block union. */
type AnthropicContentPart =
  | AnthropicTextPart
  | AnthropicImagePart
  | AnthropicToolUsePart
  | AnthropicToolResultPart

/** Anthropic Messages tool schema. */
interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** Anthropic Messages request body. */
interface AnthropicRequest {
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentPart[] }>
  max_tokens: number
  stream: true
  tools?: AnthropicTool[]
  temperature?: number
  stop_sequences?: string[]
}

/** Serialize one harness `ContentBlock` to an Anthropic content part. */
function contentBlockToPart(block: ContentBlock): AnthropicContentPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      // Reasoning content is a model artifact; fold it into the assistant
      // turn verbatim so the next round of the conversation keeps the chain.
      return { type: 'text', text: block.text }
    case 'tool-call':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (() => {
          try {
            return JSON.parse(block.arguments)
          } catch {
            return {}
          }
        })(),
      }
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content
          .filter((part): part is Extract<ContentBlock, { type: 'text' }> => part.type === 'text')
          .map((part) => ({ type: 'text' as const, text: part.text })),
        ...(block.isError === true ? { is_error: true } : {}),
      }
    case 'image':
      throw new LlmError(
        'MiniMax OAuth adapter does not support inline image content; use the attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    case 'file':
      throw new LlmError(
        'MiniMax OAuth adapter does not support inline file content; reference attachments through a tool.',
        'UNSUPPORTED_CONTENT',
      )
  }
}

/** Serialize the harness message list to the Anthropic Messages shape. */
function serializeAnthropicRequest(options: GenerateOptions): AnthropicRequest {
  const messages: AnthropicRequest['messages'] = options.messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.map(contentBlockToPart),
  }))
  const tools: AnthropicTool[] | undefined = options.tools?.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }))
  return {
    model: options.model,
    ...(options.system !== undefined && options.system.length > 0 ? { system: options.system } : {}),
    messages,
    max_tokens: options.maxTokens ?? MINIMAX_DEFAULT_MAX_TOKENS,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
  }
}

/** Map an Anthropic stop reason to a harness `FinishReason`. */
function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: {
          message: `MiniMax stream stopped unexpectedly: ${reason ?? '<unknown>'}`,
          code: (reason ?? 'unknown').toUpperCase(),
        },
      }
  }
}

/** One open content block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'tool-call'
  text: string
  toolId: string
  toolName: string
}

interface SseEvent {
  event: string
  data: string
}

/** Parse one SSE event from the stream buffer. */
function* parseSseEvents(buffer: string): Generator<SseEvent, string> {
  let cursor = 0
  while (true) {
    const blockEnd = buffer.indexOf('\n\n', cursor)
    if (blockEnd === -1) return buffer.slice(cursor)
    const block = buffer.slice(cursor, blockEnd)
    cursor = blockEnd + 2
    let eventName = 'message'
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.length === 0 || line.startsWith(':')) continue
      const colonAt = line.indexOf(':')
      if (colonAt === -1) continue
      const field = line.slice(0, colonAt)
      const value = colonAt + 1 < line.length && line[colonAt + 1] === ' '
        ? line.slice(colonAt + 2)
        : line.slice(colonAt + 1)
      if (field === 'event') eventName = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0) continue
    yield { event: eventName, data: dataLines.join('\n') }
  }
}

/** Read the SSE response stream and emit parsed events until exhaustion. */
async function* sseStream(response: Response, signal: AbortSignal): AsyncGenerator<SseEvent> {
  if (response.body === null) {
    throw new LlmError('MiniMax response stream is empty', 'TRANSPORT')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let leftover = ''
  try {
    while (true) {
      if (signal.aborted) {
        try { await reader.cancel() } catch { /* noop */ }
        throw new LlmError('MiniMax request aborted by caller', 'ABORTED')
      }
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const gen = parseSseEvents(buffer)
      for (const event of gen) {
        if (typeof event === 'string') {
          leftover = event
        } else {
          leftover = ''
          yield event
        }
      }
      buffer = leftover
    }
    buffer += decoder.decode()
    for (const event of parseSseEvents(buffer + '\n\n')) {
      if (typeof event !== 'string') yield event
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

/**
 * The MiniMax OAuth adapter.
 *
 * The adapter owns no mutable state of its own: every credential fact comes
 * from the env var, and an inline refresh writes a fresh envelope back to
 * the env var so the next request reuses it.
 */
export class MiniMaxAdapter extends LlmAdapter {
  private readonly envVar: string
  private readonly store: FileCredentialStore | undefined

  constructor(options: { envVar?: string; store?: FileCredentialStore } = {}) {
    super()
    this.envVar = options.envVar ?? MINIMAX_INFERENCE_ENV_VAR
    this.store = options.store
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'MiniMax (OAuth)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MINIMAX_DEFAULT_MODEL_CATALOG.map((entry) => {
      const info: LlmModelInfo = {
        provider,
        id: entry.id,
        name: entry.name,
      }
      if (entry.description !== undefined) {
        return { ...info, description: entry.description }
      }
      return info
    }))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configured = MINIMAX_DEFAULT_MODEL_CATALOG.find((entry) => entry.id === model)
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: configured?.name ?? model,
      context: {
        contextWindow: configured?.contextWindow ?? MINIMAX_DEFAULT_CONTEXT_WINDOW,
      },
      defaultMaxTokens: configured?.maxTokens ?? MINIMAX_DEFAULT_MAX_TOKENS,
    }
    if (configured?.description !== undefined) {
      return Promise.resolve({ ...info, description: configured.description })
    }
    return Promise.resolve(info)
  }

  /**
   * Resolve a fresh, valid access token, refreshing inline if the cached
   * envelope is within {@link MINIMAX_OAUTH_REFRESH_SKEW_SECONDS} of expiry.
   */
  async resolveAccessToken(): Promise<{ token: SerializedToken }> {
    const cached = readSerializedToken(this.envVar)
    if (cached === undefined) {
      throw new LlmError(
        `No MiniMax OAuth token in ${this.envVar}. Run \`dsh-minimax-login\` first.`,
        'MISSING_CREDENTIAL',
      )
    }
    if (!needsRefresh(cached)) return { token: cached }
    try {
      const next = await refreshToken(cached)
      writeTokenBack(this.envVar, next, this.store)
      return { token: next }
    } catch (error) {
      throw new LlmError(
        `MiniMax OAuth refresh failed: ${(error as Error).message}`,
        'AUTH',
        { cause: error },
      )
    }
  }

  /**
   * Send one request to the MiniMax Anthropic Messages endpoint with an OAuth
   * `Authorization: Bearer` header and emit the harness `StreamChunk`
   * vocabulary as the response SSE events arrive.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== MINIMAX_PROVIDER_ID) {
      throw new LlmError(
        `MiniMax adapter received unexpected provider "${options.provider}"`,
        'INVALID_REQUEST',
      )
    }
    const { token } = await this.resolveAccessToken()
    const body = serializeAnthropicRequest(options)
    const url = `${token.inference_base_url.replace(/\/+$/, '')}/v1/messages`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'authorization': `Bearer ${token.access}`,
        'anthropic-version': MINIMAX_ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(MINIMAX_OAUTH_HTTP_TIMEOUT_SECONDS * 1000 * 4),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `MiniMax API request failed (HTTP ${response.status}): ${text || response.statusText}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'TRANSPORT',
      )
    }
    const events = sseStream(response, options.signal ?? new AbortController().signal)
    const open: Map<number, OpenBlock> = new Map()
    let usage: TokenUsage | undefined
    let emittedUsage = false
    let finish: FinishReason | undefined
    let errorMessage: string | undefined
    for await (const event of events) {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        continue
      }
      switch (event.event) {
        case 'message_start': {
          const message = payload.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined
          if (message?.usage !== undefined) {
            usage = {
              inputTokens: message.usage.input_tokens ?? 0,
              outputTokens: message.usage.output_tokens ?? 0,
            }
          }
          break
        }
        case 'content_block_start': {
          const index = Number(payload.index)
          const block = payload.content_block as { type?: string; text?: string; id?: string; name?: string } | undefined
          if (block?.type === 'text') {
            open.set(index, { index, kind: 'text', text: block.text ?? '', toolId: '', toolName: '' })
            yield { type: 'block-start', index, blockType: 'text' }
            if ((block.text ?? '').length > 0) {
              yield { type: 'text-delta', index, text: block.text as string }
            }
          } else if (block?.type === 'tool_use') {
            open.set(index, {
              index,
              kind: 'tool-call',
              text: '',
              toolId: block.id ?? '',
              toolName: block.name ?? '',
            })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          break
        }
        case 'content_block_delta': {
          const index = Number(payload.index)
          const delta = payload.delta as { type?: string; text?: string; partial_json?: string } | undefined
          const current = open.get(index)
          if (delta?.type === 'text_delta' && current?.kind === 'text' && delta.text !== undefined) {
            current.text += delta.text
            yield { type: 'text-delta', index, text: delta.text }
          } else if (delta?.type === 'input_json_delta' && current?.kind === 'tool-call' && delta.partial_json !== undefined) {
            current.text += delta.partial_json
            yield {
              type: 'tool-call-delta',
              index,
              id: CallId(current.toolId ?? ''),
              ...(current.toolName !== undefined ? { name: current.toolName } : {}),
              argumentsDelta: delta.partial_json,
            }
          }
          break
        }
        case 'content_block_stop': {
          const index = Number(payload.index)
          const current = open.get(index)
          if (current === undefined) break
          if (current.kind === 'text') {
            yield { type: 'block-end', index, block: { type: 'text', text: current.text } satisfies ContentBlock }
          } else if (current.kind === 'tool-call') {
            if (current.text.length > 0) {
              try { JSON.parse(current.text) } catch { /* ignore malformed input */ }
            }
            yield {
              type: 'block-end',
              index,
              block: {
                type: 'tool-call',
                id: CallId(current.toolId ?? ''),
                name: current.toolName ?? '',
                arguments: current.text,
              } satisfies ContentBlock,
            }
          }
          open.delete(index)
          break
        }
        case 'message_delta': {
          const delta = payload.delta as { stop_reason?: string | null } | undefined
          if (delta?.stop_reason !== undefined && delta.stop_reason !== null) {
            finish = mapStopReason(delta.stop_reason)
          }
          const deltaUsage = payload.usage as { output_tokens?: number } | undefined
          if (deltaUsage?.output_tokens !== undefined) {
            usage = { ...(usage ?? { inputTokens: 0, outputTokens: 0 }), outputTokens: deltaUsage.output_tokens }
          }
          break
        }
        case 'message_stop': {
          if (finish === undefined) finish = { kind: 'stop' }
          break
        }
        case 'error': {
          const errPayload = payload.error as { message?: string; type?: string } | undefined
          errorMessage = errPayload?.message ?? 'MiniMax stream reported an error.'
          break
        }
        default:
          break
      }
    }
    if (errorMessage !== undefined) {
      throw new LlmError(`MiniMax stream error: ${errorMessage}`, 'TRANSPORT')
    }
    if (usage !== undefined && !emittedUsage) {
      yield { type: 'usage', usage }
      emittedUsage = true
    }
    yield {
      type: 'finish',
      reason: finish ?? { kind: 'stop' },
    }
  }
}
