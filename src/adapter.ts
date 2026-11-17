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
 * Harness contract implemented here (DSH `0.2.2-rc.1`):
 *   - `LlmAdapter` from `@deepseek-ai/dsh-llm`: `providerInfo`,
 *     `providerRetryPolicy`, `listModels`, `resolveModel`, `stream`.
 *   - The `0.2.x` message model: `GenerateOptions.messages` carries a
 *     discriminated union of role-tagged messages. A system prompt arrives as
 *     a leading `role: 'system'` message (the request-level `options.system`
 *     is only set by one-shot callers), and a tool result arrives as its own
 *     `role: 'tool'` message instead of a `tool-result` content block.
 *   - `ToolCallId` is the brand for tool-call correlation in `0.2.x`
 *     (renamed from `CallId`).
 *
 * Token resolution reads the serialized JSON token from the profile's env var
 * (`DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL` for Global,
 * `DSH_MINIMAX_OAUTH_TOKEN_MINIMAX_PORTAL_CN` for CN). The token envelope
 * holds the OAuth access token, refresh token, expiry, and the inference base
 * URL; an inline refresh swaps in a fresh access token when the cached one is
 * within {@link MINIMAX_OAUTH_REFRESH_SKEW_SECONDS} of expiry.
 *
 * @module dsh-llm-minimax-oauth/adapter
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  offloadedImageText,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
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
  MINIMAX_REASONING_EFFORTS,
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
function writeTokenBack(
  providerId: string,
  envVar: string,
  token: SerializedToken,
  store?: FileCredentialStore,
): void {
  process.env[envVar] = JSON.stringify(token)
  if (store !== undefined) {
    // Best-effort write; the in-process env var already has the fresh value
    // and a subsequent boot re-reads from disk, so a write failure does not
    // invalidate the live session. `providerId` (not a global constant) keeps
    // the Global and CN sessions in separate store records.
    void store.write({
      provider_id: providerId,
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

/** Anthropic Messages wire `thinking` part (assistant replay). */
interface AnthropicThinkingPart {
  type: 'thinking'
  thinking: string
  signature?: string
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
  content: Array<AnthropicTextPart | AnthropicImagePart> | string
  is_error?: boolean
}

/** Anthropic Messages content block union. */
type AnthropicContentPart =
  | AnthropicTextPart
  | AnthropicImagePart
  | AnthropicThinkingPart
  | AnthropicToolUsePart
  | AnthropicToolResultPart

/** Anthropic Messages tool schema. */
interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** Anthropic Messages thinking configuration. */
interface AnthropicThinking {
  type: 'adaptive' | 'enabled' | 'disabled'
  budget_tokens?: number
}

/** Anthropic Messages reasoning-effort configuration. */
interface AnthropicOutputConfig {
  effort: string
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
  thinking?: AnthropicThinking
  output_config?: AnthropicOutputConfig
}

/**
 * The attachment reference this route reads image bytes from.
 *
 * The harness owns the durable attachment vocabulary (`@deepseek-ai/dsh-attachment`),
 * but `@deepseek-ai/dsh-llm` imports those types without re-exporting them, and
 * adding a direct dependency on the attachment package would pin this plugin
 * to one harness generation. The route therefore derives the type from the
 * harness' own image helper, which every harness line exports: the attachment
 * service is provided by the host, and this description stays valid across
 * harness generations.
 */
type MiniMaxImageRef = Parameters<typeof requestImageHandleText>[0]

/** The request-image projection this route asks the attachment service for. */
type MiniMaxImageTarget = ReturnType<LlmAdapter['imageRequestTarget']>

/**
 * The request-image variant this route receives from the attachment service.
 *
 * Structurally the harness' `RequestImageAttachment`: the exact bytes for one
 * request plus the display metadata the handle text names.
 */
interface MiniMaxRequestImage {
  data: Uint8Array
  mediaType: string
  bytes: number
  width: number
  height: number
}

/**
 * The attachment service this route reads images through.
 *
 * The host provides `ctx.attachments`; the route only needs the one method it
 * calls, so the service is described structurally rather than imported.
 */
export interface MiniMaxAttachmentStore {
  readImageRequest(
    ref: MiniMaxImageRef,
    target: MiniMaxImageTarget,
    signal?: AbortSignal,
  ): Promise<MiniMaxRequestImage>
}

/** Resolves the attachment service, if the host provides one. */
export type MiniMaxAttachmentResolver = () => MiniMaxAttachmentStore | undefined

/**
 * Request-image budget of this route.
 *
 * MiniMax accepts base64 image sources, so the route accounts the encoded
 * length. The limits mirror the harness' own `pi-ai` route: 1 MiB per image,
 * 50 images per request, and a 2048x2048 pixel budget, which is the pixel
 * limit the MiniMax provider data documents for its image models.
 */
const MINIMAX_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const MINIMAX_REQUEST_IMAGE_MAX_IMAGES = 50
const MINIMAX_REQUEST_IMAGE_MAX_PIXELS = 2048 * 2048

/**
 * Scale one image to the route's pixel budget.
 *
 * The attachment service does the resizing; the route only states the
 * dimensions it is willing to send, so an oversized image reaches the model
 * as a smaller preview instead of an oversized payload.
 * @param width - the stored image's width in pixels.
 * @param height - the stored image's height in pixels.
 * @returns the dimensions to request, never larger than the source.
 */
function projectImageDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const total = width * height
  if (total <= MINIMAX_REQUEST_IMAGE_MAX_PIXELS || total === 0) return { width, height }
  const scale = Math.sqrt(MINIMAX_REQUEST_IMAGE_MAX_PIXELS / total)
  if (width >= height) {
    const projectedWidth = Math.max(1, Math.floor(width * scale))
    return {
      width: projectedWidth,
      height: Math.max(1, Math.round((projectedWidth * height) / width)),
    }
  }
  const projectedHeight = Math.max(1, Math.floor(height * scale))
  return {
    width: Math.max(1, Math.round((projectedHeight * width) / height)),
    height: projectedHeight,
  }
}

/** One request image, keyed by the durable attachment id it was read from. */
interface MiniMaxPreparedImage extends MiniMaxRequestImage {
  attachmentId: string
}

/**
 * Read every image occurrence of a request through the attachment service.
 *
 * The service returns the exact bytes for one request version, so the same
 * attachment read twice yields the same image and is read once.
 * @param messages - the request history.
 * @param attachments - the host's attachment service.
 * @param signal - cancellation for the read.
 * @returns the prepared images, keyed by attachment id.
 */
async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: MiniMaxAttachmentStore,
  signal?: AbortSignal,
): Promise<Map<string, MiniMaxPreparedImage>> {
  const refs = new Map<string, MiniMaxImageRef>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (block.offloaded === true) continue
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  const prepared = new Map<string, MiniMaxPreparedImage>()
  for (const [attachmentId, ref] of refs) {
    const dimensions = projectImageDimensions(ref.width, ref.height)
    const image = await attachments.readImageRequest(
      ref,
      { ...dimensions, maxBytes: MINIMAX_REQUEST_IMAGE_MAX_BYTES },
      signal,
    )
    prepared.set(attachmentId, { ...image, attachmentId })
  }
  return prepared
}

/**
 * Parse a model-produced tool-arguments string into a JSON object.
 *
 * The Anthropic wire format types `tool_use.input` as an object, while the
 * harness keeps the raw JSON text. A malformed fragment is sent as an empty
 * object rather than dropped: the model still sees the call it made, and the
 * tool reports the missing arguments itself.
 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Serialize one harness `ContentBlock` to an Anthropic content part.
 *
 * Text and tool calls map one-to-one. Reasoning maps to an Anthropic
 * `thinking` part when the caller supplies the provider's signature (the
 * signature is what lets the provider validate the replayed chain), and to
 * plain text otherwise. Images and files are handled by the caller, which
 * owns the attachment bytes.
 */
function contentBlockToPart(block: ContentBlock, signature?: string): AnthropicContentPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      // Reasoning content is a model artifact; fold it into the assistant
      // turn verbatim so the next round of the conversation keeps the chain.
      return signature === undefined
        ? { type: 'text', text: block.text }
        : { type: 'thinking', thinking: block.text, signature }
    case 'tool-call':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parseToolArguments(block.arguments),
      }
    case 'image':
      throw new LlmError(
        'MiniMax OAuth adapter cannot serialize an image block without the attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    case 'file':
      throw new LlmError(
        'MiniMax OAuth adapter does not support inline file content; reference attachments through a tool.',
        'UNSUPPORTED_CONTENT',
      )
    default:
      // Tool-change blocks belong to developer messages; reaching one inside a
      // conversation message means the caller mixed the two vocabularies.
      throw new LlmError(
        `MiniMax OAuth adapter cannot represent "${String((block as { type: string }).type)}" content in a conversation message.`,
        'UNSUPPORTED_CONTENT',
      )
  }
}

/**
 * Serialize one image block to the Anthropic wire form.
 *
 * MiniMax accepts base64 image sources, which is what this route sends. The
 * handle text names the exact request image so the model can refer to it, and
 * the image itself follows as a separate part.
 * @param block - the harness image block.
 * @param image - the request image read for that occurrence.
 * @returns the wire parts: the handle text and the image.
 */
function imageBlockToParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  image: MiniMaxPreparedImage,
): AnthropicContentPart[] {
  return [
    { type: 'text', text: requestImageHandleText(block.attachment, image) },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: Buffer.from(image.data).toString('base64'),
      },
    },
  ]
}

/** Join the text blocks of one harness message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Split the request into the Anthropic top-level system slot and the
 * remaining conversation messages.
 *
 * In the `0.2.x` message model the system prompt is a leading
 * `role: 'system'` message; `options.system` is only populated by one-shot
 * callers. Both are merged into the single Anthropic `system` field, joined
 * the same way the built-in `pi-ai` adapter joins them.
 *
 * The Anthropic Messages format has exactly one system slot, so a system
 * message that is *not* leading cannot be represented in history either.
 * It is folded into the same slot instead of being dropped, which keeps the
 * prompt visible to the model rather than silently losing it.
 */
function splitSystemPrompt(options: GenerateOptions): {
  system?: string
  messages: RequestMessage[]
} {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    parts.push(options.system)
  }
  const messages: RequestMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) parts.push(text)
      continue
    }
    messages.push(message)
  }
  return {
    ...(parts.length > 0 ? { system: parts.join('\n\n') } : {}),
    messages,
  }
}

/**
 * Convert one harness tool-result message into an Anthropic `tool_result`
 * part.
 *
 * In the `0.2.x` message model a tool result is its own `role: 'tool'`
 * message: the call correlation lives on the message (`toolCallId`) and the
 * failure flag on the message (`isError`), not inside a content block. The
 * Anthropic wire format carries the same three facts inside one part, which
 * is why the part rides in a `user`-role message.
 */
function toolResultToPart(message: ToolResultMessage): AnthropicToolResultPart {
  const text = flattenText(message.content)
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: text.length > 0 ? [{ type: 'text', text }] : '',
    ...(message.isError === true ? { is_error: true } : {}),
  }
}

/**
 * The replay envelope this route writes for assistant history.
 *
 * The harness' `ReasoningBlock` carries the reasoning text but not the
 * provider's signature, and the signature is what lets MiniMax validate a
 * replayed thinking chain. The route therefore stores the signature beside
 * the assembled blocks in the envelope the harness attaches to the assistant
 * message, and reads it back when the next request replays that message.
 */
const MINIMAX_REPLAY_KIND = 'minimax-anthropic'

/** One entry of the per-block half of this route's replay envelope. */
interface MiniMaxReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  /** The provider's thinking signature, for a reasoning block. */
  thinkingSignature?: string
}

/** The response-level half of this route's replay envelope. */
interface MiniMaxReplayResponse {
  kind: typeof MINIMAX_REPLAY_KIND
  version: 1
  provider: string
  model: string
}

/**
 * The replay envelope this route writes.
 *
 * The harness' `ReplayEnvelope` names the two halves `response` and `blocks`;
 * the per-block half must have exactly one entry per emitted block, in
 * first-seen stream order, or the harness discards the whole envelope.
 */
interface MiniMaxReplayEnvelope {
  response: MiniMaxReplayResponse
  blocks: MiniMaxReplayBlock[]
}

/**
 * Read the per-block replay metadata of one assistant message.
 *
 * The envelope belongs to the route that produced it; a message that another
 * adapter produced carries foreign state, and the harness strips that before
 * dispatch anyway.
 * @param message - the request history entry.
 * @returns the per-block metadata, when this route produced the message.
 */
function replayBlocksOf(message: RequestMessage): readonly MiniMaxReplayBlock[] | undefined {
  if (message.role !== 'assistant') return undefined
  const state: unknown = message.source.replayState
  if (state === null || typeof state !== 'object') return undefined
  const envelope = state as { response?: unknown; blocks?: unknown }
  const response = envelope.response
  if (response === null || typeof response !== 'object') return undefined
  if ((response as { kind?: unknown }).kind !== MINIMAX_REPLAY_KIND) return undefined
  if (!Array.isArray(envelope.blocks)) return undefined
  return envelope.blocks as MiniMaxReplayBlock[]
}

/**
 * Convert the harness request history into Anthropic Messages wire messages.
 *
 * Role mapping:
 *   - `user`      → Anthropic `user` message.
 *   - `assistant` → Anthropic `assistant` message.
 *   - `tool`      → Anthropic `user` message holding one `tool_result` part,
 *                   because the Anthropic format expects tool output as a
 *                   user turn that answers the preceding `tool_use`.
 *   - `developer` → dropped. This route declares no `toolUpdate`, so the
 *                   harness sends the complete tool list on every request and
 *                   the developer blocks carry no extra information.
 *
 * Image occurrences become the handle text plus the base64 image. Occurrences
 * the surface marked `offloaded` are replaced with the harness' own
 * placeholder, so an omitted image stays visible to the model as an omission
 * rather than disappearing.
 *
 * @param messages - the request history.
 * @param images - the prepared request images, keyed by attachment id.
 * @returns the wire messages.
 */
function toAnthropicMessages(
  messages: readonly RequestMessage[],
  images: ReadonlyMap<string, MiniMaxPreparedImage>,
): AnthropicRequest['messages'] {
  const out: AnthropicRequest['messages'] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'assistant': {
        const replay = replayBlocksOf(message)
        const parts: AnthropicContentPart[] = []
        message.content.forEach((block, position) => {
          if (block.type === 'image') {
            const image = images.get(block.attachment.attachmentId)
            if (image === undefined) {
              if (block.offloaded === true) {
                // The surface dropped this occurrence to fit a request limit.
                // The harness' placeholder says exactly that.
                parts.push({ type: 'text', text: offloadedImageText(block.attachment) })
                return
              }
              // The occurrence is still part of the request but the route has
              // no bytes for it. Sending it as a placeholder would quietly
              // change what the user asked, so the request fails instead.
              throw new LlmError(
                'MiniMax OAuth adapter cannot serialize an image block without the attachment service.',
                'UNSUPPORTED_CONTENT',
              )
            }
            parts.push(...imageBlockToParts(block, image))
            return
          }
          if (block.type === 'reasoning') {
            const signature = replay?.[position]?.thinkingSignature
            parts.push(contentBlockToPart(block, signature))
            return
          }
          parts.push(contentBlockToPart(block))
        })
        if (parts.length === 0) continue
        out.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: parts,
        })
        break
      }
      case 'tool': {
        const parts: AnthropicContentPart[] = []
        for (const block of message.content) {
          if (block.type === 'image') {
            const image = images.get(block.attachment.attachmentId)
            if (image === undefined) {
              if (block.offloaded === true) {
                parts.push({ type: 'text', text: offloadedImageText(block.attachment) })
                continue
              }
              throw new LlmError(
                'MiniMax OAuth adapter cannot serialize an image block without the attachment service.',
                'UNSUPPORTED_CONTENT',
              )
            }
            parts.push(...imageBlockToParts(block, image))
            continue
          }
        }
        parts.push(toolResultToPart(message))
        out.push({ role: 'user', content: parts })
        break
      }
      case 'developer':
        break
      default:
        break
    }
  }
  return out
}

/**
 * Build the thinking configuration for one request.
 *
 * MiniMax's `MiniMax-M3.1-Flash` requires adaptive thinking and rejects
 * `thinking.type="disabled"` with HTTP 400, while the other models accept it.
 * Because the route cannot know which model a caller will pick before the
 * request is built, it always asks for adaptive thinking: the provider then
 * decides whether to think, and no model rejects the request.
 * @returns the wire thinking configuration.
 */
function thinkingConfiguration(): AnthropicThinking {
  return { type: 'adaptive' }
}

/**
 * Build the reasoning-effort configuration for one request.
 *
 * MiniMax accepts `low`, `medium`, `high`, `xhigh` and `max`, and rejects any
 * other value with HTTP 400. The provider treats the effort as a hint, so an
 * effort outside that set is dropped rather than sent.
 * @param effort - the effort the caller selected, if any.
 * @returns the wire effort configuration, when the effort is one MiniMax accepts.
 */
function outputConfiguration(effort: string | undefined): AnthropicOutputConfig | undefined {
  if (effort === undefined) return undefined
  if (!MINIMAX_REASONING_EFFORTS.includes(effort)) return undefined
  return { effort }
}

/**
 * Serialize the harness request to the Anthropic Messages body.
 *
 * Tool declarations follow the built-in `pi-ai` adapter: a tool marked
 * `deferLoading` is not part of the wire declaration list, because its
 * schema is activated by a developer event instead.
 *
 * The temperature is left out: MiniMax enables thinking on this route, and a
 * request that asks for thinking and a temperature at the same time is not
 * portable across the Anthropic-compatible endpoints this route serves.
 *
 * @param options - the harness request.
 * @param system - the merged system prompt.
 * @param messages - the request history without the system prompt.
 * @param images - the prepared request images, keyed by attachment id.
 * @returns the wire request body.
 */
function serializeAnthropicRequest(
  options: GenerateOptions,
  system: string | undefined,
  messages: readonly RequestMessage[],
  images: ReadonlyMap<string, MiniMaxPreparedImage>,
): AnthropicRequest {
  const tools: AnthropicTool[] | undefined = options.tools
    ?.filter((tool) => tool.deferLoading !== true)
    .map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
  const effort = outputConfiguration(options.reasoningEffort)
  return {
    model: options.model,
    ...(system !== undefined ? { system } : {}),
    messages: toAnthropicMessages(messages, images),
    max_tokens: options.maxTokens ?? MINIMAX_DEFAULT_MAX_TOKENS,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
    thinking: thinkingConfiguration(),
    ...(effort === undefined ? {} : { output_config: effort }),
  }
}

/**
 * The harness failure codes this route can raise.
 *
 * The codes are the harness' own vocabulary, spelled out locally instead of
 * imported: `@deepseek-ai/dsh-llm` only publishes the `BuiltinLlmFailureCode`
 * union from `0.2.2-rc.3` on, while the runtime accepts any non-empty code
 * string. Naming them here keeps one source tree buildable against every
 * `0.2.x` harness line, and every code listed is a member of the harness'
 * built-in table (see `LLM_FAILURE_CODES` in `@deepseek-ai/dsh-llm`), so the
 * harness routes on them exactly as it does for its own adapters.
 */
export type MiniMaxFailureCode =
  | 'ABORTED'
  | 'AUTH'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'EMPTY_RESPONSE'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'MALFORMED_RESPONSE'
  | 'MISSING_CREDENTIAL'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'STREAM_CLOSED'
  | 'TRANSPORT'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_CONTENT'

/**
 * Classify a provider-reported stream error into a built-in failure code.
 *
 * The harness routes on the code, so a provider error type must not be
 * forwarded as one: an overloaded or throttled upstream is retryable, while a
 * malformed answer is not.
 * @param errorType - the provider's `error.type`, when it sent one.
 * @returns the built-in failure code for that error type.
 */
function classifyStreamError(errorType: string | undefined): MiniMaxFailureCode {
  switch (errorType) {
    case 'overloaded_error':
      return 'SERVER'
    case 'rate_limit_error':
      return 'RATE_LIMIT'
    case 'authentication_error':
    case 'permission_error':
      return 'AUTH'
    case 'invalid_request_error':
      return 'INVALID_REQUEST'
    case 'not_found_error':
      return 'UNKNOWN_MODEL'
    default:
      return 'TRANSPORT'
  }
}

/**
 * Map an Anthropic stop reason to a harness `FinishReason`.
 *
 * The failure `code` must be one of the harness' built-in LLM failure codes.
 * The harness re-raises an in-band failure through `LlmError.fromFailure`,
 * whose constructor rejects an empty code outright, and the harness routes on
 * the code — so a raw provider stop reason is never usable as one. Every
 * unrecognized reason therefore maps onto a built-in code, and the reason
 * itself stays in the message where a human (and the log) can still read it.
 *
 * @param reason - the provider's `stop_reason`, possibly empty or unknown.
 * @returns the harness finish reason for that stop reason.
 */
function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'pause_turn':
      // Anthropic's server-side pause is not a failure: the caller resubmits.
      return { kind: 'stop' }
    case 'refusal':
    case 'sensitive':
      return {
        kind: 'error',
        failure: {
          message: `MiniMax refused the request (stop reason "${reason}")`,
          code: 'UNSUPPORTED_CONTENT',
        },
      }
    case 'model_context_window_exceeded':
      return {
        kind: 'error',
        failure: {
          message: 'MiniMax reported that the model context window was exceeded',
          code: 'CONTEXT_WINDOW_EXCEEDED',
        },
      }
    default: {
      const detail = reason === undefined || reason === null || reason === ''
        ? '<empty>'
        : reason
      return {
        kind: 'error',
        failure: {
          message: `MiniMax stream stopped with an unexpected stop reason: ${detail}`,
          code: 'INVALID_RESPONSE',
        },
      }
    }
  }
}

/**
 * Serialize a tool call's `input` object into the harness' raw-arguments
 * string. The harness keeps tool arguments as the raw JSON text the provider
 * sent, and a provider may deliver the object either in the start event or as
 * streamed `input_json_delta` fragments.
 * @param input - the provider's `input` value, usually an object.
 * @returns the JSON text, or an empty string when there is no input at all.
 */
function serializeToolInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

/**
 * Validate the accumulated tool-call arguments before the harness sees them.
 *
 * The harness keeps tool arguments as the raw JSON text the provider sent and
 * hands that text straight to the tool dispatcher, so an invalid JSON string
 * would arrive as an unusable call. An empty argument string is valid: it is
 * what a tool with no arguments looks like.
 * @param name - the tool name, for the error message.
 * @param argumentsText - the accumulated raw arguments.
 * @throws an {@link LlmError} with a built-in code when the arguments are not
 *   valid JSON.
 */
function assertValidToolArguments(name: string, argumentsText: string): void {
  if (argumentsText.trim() === '') return
  try {
    JSON.parse(argumentsText)
  } catch (error) {
    throw new LlmError(
      `MiniMax returned invalid JSON arguments for tool "${name}": ${(error as Error).message}`,
      'MALFORMED_RESPONSE',
    )
  }
}

/** One open content block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolId: string
  toolName: string
  /** The `input` object the provider sent with `content_block_start`. */
  startInput: string
  /** The provider's thinking signature, for a reasoning block. */
  signature: string
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
  private readonly providerId: string
  private readonly displayName: string
  private readonly store: FileCredentialStore | undefined
  private readonly resolveAttachments: MiniMaxAttachmentResolver | undefined

  constructor(
    options: {
      envVar?: string
      providerId?: string
      displayName?: string
      store?: FileCredentialStore
      /**
       * Resolves the host's attachment service.
       *
       * The service owns the image bytes; the adapter only asks it for the
       * exact request version of one image. Without the service the route
       * cannot inline an image, and a request that carries one fails with
       * `UNSUPPORTED_CONTENT` instead of silently dropping the picture.
       */
      resolveAttachments?: MiniMaxAttachmentResolver
    } = {},
  ) {
    super()
    this.envVar = options.envVar ?? MINIMAX_INFERENCE_ENV_VAR
    this.providerId = options.providerId ?? MINIMAX_PROVIDER_ID
    this.displayName = options.displayName ?? 'MiniMax (OAuth)'
    this.store = options.store
    this.resolveAttachments = options.resolveAttachments
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /**
   * The request-image dimensions and byte target of one image.
   *
   * The route sends images as base64, so the budget is stated in the encoded
   * length the wire body actually carries, and the pixel budget keeps an
   * oversized picture from becoming an oversized payload.
   * @param provider - the provider route that owns the model.
   * @param model - the model the image is sent to.
   * @param image - the durable image reference.
   * @returns the dimensions and byte target the attachment service should honor.
   */
  override imageRequestTarget(
    _provider: string,
    _model: string,
    image: MiniMaxImageRef,
  ): MiniMaxImageTarget {
    const dimensions = projectImageDimensions(image.width, image.height)
    return { ...dimensions, maxBytes: MINIMAX_REQUEST_IMAGE_MAX_BYTES }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    // The host's normal defaults already cover the transient failures this
    // route can raise (EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT).
    // `STREAM_CLOSED` is a retry choice of the harness but is not in that
    // default list, and a truncated MiniMax stream is exactly the case worth
    // repeating, so it is added here.
    return {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: [
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
        'STREAM_CLOSED',
      ],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  /**
   * The reasoning efforts MiniMax accepts.
   *
   * The provider rejects an unknown effort with HTTP 400, so the route only
   * advertises the values it is willing to send.
   */
  private reasoningInfo(): LlmModelReasoningInfo {
    return {
      efforts: MINIMAX_REASONING_EFFORTS.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
      defaultEffort: ReasoningEffortId('medium'),
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MINIMAX_DEFAULT_MODEL_CATALOG.map((entry) => {
      const info: LlmModelInfo = {
        provider,
        id: entry.id,
        name: entry.name,
        // MiniMax's M3 models accept images; the M2.7 line is text only. The
        // declaration is what lets the harness hand a real image block to
        // this route instead of projecting it to text.
        inputModalities: entry.inputModalities,
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
      inputModalities: configured?.inputModalities ?? ['text'],
      context: {
        contextWindow: configured?.contextWindow ?? MINIMAX_DEFAULT_CONTEXT_WINDOW,
      },
      defaultMaxTokens: configured?.maxTokens ?? MINIMAX_DEFAULT_MAX_TOKENS,
      reasoning: this.reasoningInfo(),
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
      writeTokenBack(this.providerId, this.envVar, next, this.store)
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
    if (options.provider !== this.providerId) {
      throw new LlmError(
        `MiniMax adapter received unexpected provider "${options.provider}"`,
        'INVALID_REQUEST',
      )
    }
    const { token } = await this.resolveAccessToken()
    const { system, messages } = splitSystemPrompt(options)
    const images = await this.prepareImages(messages, options.signal)
    const body = serializeAnthropicRequest(options, system, messages, images)
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
    /** The per-block replay metadata, in first-seen block order. */
    const replayBlocks: MiniMaxReplayBlock[] = []
    /** The block index each replay entry belongs to. */
    const replayIndexes: number[] = []
    let usage: TokenUsage | undefined
    let emittedUsage = false
    let finish: FinishReason | undefined
    let errorMessage: string | undefined
    let errorType: string | undefined
    let sawTerminalEvent = false
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
          const block = payload.content_block as
            | { type?: string; text?: string; id?: string; name?: string; input?: unknown }
            | undefined
          if (block?.type === 'text') {
            open.set(index, { index, kind: 'text', text: block.text ?? '', toolId: '', toolName: '', startInput: '', signature: '' })
            replayBlocks.push({ type: 'text' })
            replayIndexes.push(index)
            yield { type: 'block-start', index, blockType: 'text' }
            if ((block.text ?? '').length > 0) {
              yield { type: 'text-delta', index, text: block.text as string }
            }
          } else if (block?.type === 'thinking') {
            // MiniMax emits its reasoning as a `thinking` block. The harness
            // models that as a reasoning block, so the text travels as a
            // reasoning delta and stays visible in the transcript.
            open.set(index, { index, kind: 'reasoning', text: '', toolId: '', toolName: '', startInput: '', signature: '' })
            replayBlocks.push({ type: 'reasoning' })
            replayIndexes.push(index)
            yield { type: 'block-start', index, blockType: 'reasoning' }
          } else if (block?.type === 'tool_use') {
            open.set(index, {
              index,
              kind: 'tool-call',
              text: '',
              toolId: block.id ?? '',
              toolName: block.name ?? '',
              // Some providers send the whole argument object in the start
              // event and no `input_json_delta` at all. Remember it so the
              // block never ends up with empty arguments.
              startInput: serializeToolInput(block.input),
              signature: '',
            })
            replayBlocks.push({ type: 'tool-call' })
            replayIndexes.push(index)
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          break
        }
        case 'content_block_delta': {
          const index = Number(payload.index)
          const delta = payload.delta as
            | { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
            | undefined
          const current = open.get(index)
          if (delta?.type === 'text_delta' && current?.kind === 'text' && delta.text !== undefined) {
            current.text += delta.text
            yield { type: 'text-delta', index, text: delta.text }
          } else if (
            delta?.type === 'thinking_delta'
            && current?.kind === 'reasoning'
            && delta.thinking !== undefined
          ) {
            current.text += delta.thinking
            yield { type: 'reasoning-delta', index, text: delta.thinking }
          } else if (
            delta?.type === 'signature_delta'
            && current?.kind === 'reasoning'
            && delta.signature !== undefined
          ) {
            // The signature is what lets MiniMax validate the replayed
            // thinking chain on the next request. It is kept beside the
            // block and stored in the replay envelope.
            current.signature = delta.signature
          } else if (delta?.type === 'input_json_delta' && current?.kind === 'tool-call' && delta.partial_json !== undefined) {
            current.text += delta.partial_json
            yield {
              type: 'tool-call-delta',
              index,
              id: ToolCallId(current.toolId ?? ''),
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
          } else if (current.kind === 'reasoning') {
            yield {
              type: 'block-end',
              index,
              block: { type: 'reasoning', text: current.text } satisfies ContentBlock,
            }
            const position = replayIndexes.indexOf(index)
            const replayBlock = position >= 0 ? replayBlocks[position] : undefined
            if (replayBlock !== undefined && current.signature.length > 0) {
              replayBlock.thinkingSignature = current.signature
            }
          } else if (current.kind === 'tool-call') {
            // A provider may deliver the arguments only in the start event.
            // Falling back to it keeps the block from ending up empty.
            const argumentsText = current.text === '' ? current.startInput : current.text
            assertValidToolArguments(current.toolName, argumentsText)
            yield {
              type: 'block-end',
              index,
              block: {
                type: 'tool-call',
                id: ToolCallId(current.toolId ?? ''),
                name: current.toolName ?? '',
                arguments: argumentsText,
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
          const deltaUsage = payload.usage as
            | { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }
            | undefined
          if (deltaUsage?.output_tokens !== undefined) {
            usage = { ...(usage ?? { inputTokens: 0, outputTokens: 0 }), outputTokens: deltaUsage.output_tokens }
          }
          const thinkingTokens = deltaUsage?.output_tokens_details?.thinking_tokens
          if (thinkingTokens !== undefined) {
            usage = {
              ...(usage ?? { inputTokens: 0, outputTokens: 0 }),
              reasoningTokens: thinkingTokens,
            }
          }
          break
        }
        case 'message_stop': {
          sawTerminalEvent = true
          if (finish === undefined) finish = { kind: 'stop' }
          break
        }
        case 'error': {
          const errPayload = payload.error as { message?: string; type?: string } | undefined
          errorMessage = errPayload?.message ?? 'MiniMax stream reported an error.'
          errorType = errPayload?.type
          break
        }
        default:
          break
      }
    }
    if (errorMessage !== undefined) {
      throw new LlmError(`MiniMax stream error: ${errorMessage}`, classifyStreamError(errorType))
    }
    if (finish === undefined && !sawTerminalEvent) {
      // The provider closed the stream without a terminal event. Reporting a
      // plain stop here would hide a truncated turn behind an empty answer, so
      // surface it as a retryable stream failure instead.
      finish = {
        kind: 'error',
        failure: {
          message:
            'MiniMax stream ended before the provider sent a completion event; this turn may be incomplete',
          code: 'STREAM_CLOSED',
        },
      }
    }
    if (usage !== undefined && !emittedUsage) {
      // The Anthropic wire format reports no total, so derive it from the
      // authoritative prompt/output counters the harness meter expects.
      yield { type: 'usage', usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } }
      emittedUsage = true
    }
    yield {
      type: 'finish',
      reason: finish ?? { kind: 'stop' },
      ...(replayBlocks.length > 0
        ? {
            replayState: {
              response: {
                kind: MINIMAX_REPLAY_KIND,
                version: 1,
                provider: this.providerId,
                model: options.model,
              },
              blocks: replayBlocks,
            },
          }
        : {}),
    }
  }

  /**
   * Read the request images of one request through the attachment service.
   *
   * The service owns the bytes, so the route asks it for the exact request
   * version of every image occurrence and then checks the request against
   * the route's image budget. A request that exceeds the budget fails with
   * `IMAGE_OFFLOAD_REQUIRED`, naming how many oldest occurrences the surface
   * has to drop, which is the decision the harness makes, not this route.
   * @param messages - the request history without the system prompt.
   * @param signal - cancellation for the read.
   * @returns the prepared images, keyed by attachment id.
   */
  private async prepareImages(
    messages: readonly RequestMessage[],
    signal?: AbortSignal,
  ): Promise<Map<string, MiniMaxPreparedImage>> {
    const attachments = this.resolveAttachments?.()
    if (attachments === undefined) return new Map()
    const images = await prepareRequestImages(messages, attachments, signal)
    if (images.size === 0) return images
    const offloadImages = requiredImageOffload(
      messages,
      {
        representation: 'base64',
        maxBytes: MINIMAX_REQUEST_IMAGE_MAX_BYTES * MINIMAX_REQUEST_IMAGE_MAX_IMAGES,
        maxImages: MINIMAX_REQUEST_IMAGE_MAX_IMAGES,
      },
      (block) => images.get(block.attachment.attachmentId)?.bytes ?? 0,
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `MiniMax request images exceed the route image budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
    return images
  }
}
