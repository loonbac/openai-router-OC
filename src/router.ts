#!/usr/bin/env node
/**
 * router.ts — Embedded HTTP proxy for OpenAI Codex
 *
 * Accepts OpenAI-compatible requests, proxies to Codex API with account rotation.
 * Multi-instance resilient via heartbeat coordination.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { loadStore, updateAccount } from './store.js'
import {
  getNextAccount,
  markAuthInvalid,
  markRateLimited,
  markModelUnsupported,
  markWorkspaceDeactivated
} from './rotation.js'
import { getDefaultModels } from './models.js'
import { getForceState, isForceActive } from './force-mode.js'
import { getRuntimeSettings } from './settings.js'
import {
  extractRateLimitUpdate,
  getBlockingRateLimitResetAt,
  mergeRateLimits,
  parseRateLimitResetFromError,
  parseRetryAfterHeader
} from './rate-limits.js'
import { Errors } from './errors.js'
import { syncAuthFromOpenCode } from './auth-sync.js'
import type { PluginConfig, AccountRateLimits } from './types.js'
import { DEFAULT_CONFIG } from './types.js'
import {
  startHeartbeat,
  stopHeartbeat,
  connectionStart,
  connectionEnd,
  getIdleTimeMs,
  getActiveConnections,
  releaseLock
} from './heartbeat.js'

// ─── Constants ─────────────────────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`
const OPENAI_HEADERS = {
  BETA: 'OpenAI-Beta',
  ACCOUNT_ID: 'chatgpt-account-id',
  ORIGINATOR: 'originator',
  SESSION_ID: 'session_id',
  CONVERSATION_ID: 'conversation_id'
}
const OPENAI_HEADER_VALUES = {
  BETA_RESPONSES: 'responses=experimental',
  ORIGINATOR_CODEX: 'codex_cli_rs'
}
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const DEFAULT_LATEST_CODEX_MODEL = 'gpt-5.5'

// ─── Config ────────────────────────────────────────────────────────────

const PORT = Number(process.env.OPENCODE_MULTI_AUTH_ROUTER_PORT || 47990)
const IDLE_SHUTDOWN_MS = 30_000
const DRAIN_TIMEOUT_MS = 10_000

let pluginConfig: PluginConfig = { ...DEFAULT_CONFIG }

// ─── Helpers (from index.ts) ──────────────────────────────────────────

function decodeJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'))
  } catch { return null }
}

function normalizeModel(model: string | undefined): string {
  if (!model) return 'gpt-5.1'
  const modelId = model.includes('/') ? model.split('/').pop()! : model
  return modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '')
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.5' || model === 'gpt-5.4'
}

function extractErrorMessage(payload: any, fallbackText: string = ''): string {
  if (!payload || typeof payload !== 'object') return fallbackText
  const detailMessage = typeof payload?.detail?.message === 'string'
    ? payload.detail.message
    : typeof payload?.detail === 'string' ? payload.detail : ''
  const errorMessage = typeof payload?.error?.message === 'string' ? payload.error.message : ''
  const topLevelMessage = typeof payload?.message === 'string' ? payload.message : ''
  return detailMessage || errorMessage || topLevelMessage || fallbackText
}

function resolveRateLimitedUntil(
  rateLimits: AccountRateLimits | undefined,
  headers: Headers,
  errorText: string,
  fallbackCooldownMs: number,
  now: number = Date.now()
): number {
  const retryAfterUntil = parseRetryAfterHeader(headers.get('retry-after'), now) || 0
  const windowResetUntil = getBlockingRateLimitResetAt(rateLimits, now, {
    conservativeWhenRemainingUnknown: true
  }) || 0
  const messageResetUntil = parseRateLimitResetFromError(errorText, now) || 0
  const fallbackUntil = now + fallbackCooldownMs
  return Math.max(fallbackUntil, retryAfterUntil, windowResetUntil, messageResetUntil)
}

// ─── SSE Transform ────────────────────────────────────────────────────

function transformSSEEvent(codexEvent: { type: string; [key: string]: any }): string | null {
  switch (codexEvent.type) {
    case 'response.output_text.delta': {
      const chunk = {
        id: codexEvent.item_id?.replace('msg_', 'chatcmpl-') || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{
          index: 0,
          delta: { content: codexEvent.delta || '' },
          finish_reason: null
        }]
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    case 'response.completed': {
      const chunk = {
        id: 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      }
      return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
    }
    case 'response.failed':
    case 'error': {
      const err = {
        error: {
          message: codexEvent.error?.message || codexEvent.message || 'Unknown error',
          type: 'server_error',
          code: codexEvent.error?.code || 'unknown'
        }
      }
      return `data: ${JSON.stringify(err)}\n\ndata: [DONE]\n\n`
    }
    default:
      return null
  }
}

// ─── Codex Proxy ──────────────────────────────────────────────────────

interface ProxyOptions {
  body: object
  token: string
  accountId: string
  onEvent: (sseLine: string) => void
  onError: (err: Error) => void
  onClose: () => void
  signal?: AbortSignal
}

async function proxyToCodex(options: ProxyOptions): Promise<void> {
  const { body, token, accountId, onEvent, onError, onClose, signal } = options

  try {
    const res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': OPENAI_HEADER_VALUES.BETA_RESPONSES,
        [OPENAI_HEADERS.ACCOUNT_ID]: accountId,
        [OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      const err = new Error(`Codex API ${res.status}: ${errText}`) as Error & { status: number }
      err.status = res.status
      onError(err)
      return
    }

    if (!res.body) {
      onError(new Error('No response body from Codex API'))
      return
    }

    // Parse SSE stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const lines = part.split('\n')
        let eventType = ''
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7)
          else if (line.startsWith('data: ')) eventData = line.slice(6)
        }

        if (eventType && eventData) {
          try {
            const parsed = JSON.parse(eventData)
            onEvent(JSON.stringify({ type: eventType, ...parsed }))
          } catch {
            onEvent(JSON.stringify({ type: eventType, raw: eventData }))
          }
        }
      }
    }

    onClose()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      onClose()
    } else {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

// ─── Hono App ─────────────────────────────────────────────────────────

const app = new Hono()

// Connection tracking middleware
app.use('*', async (c, next) => {
  connectionStart()
  try { await next() } finally { connectionEnd() }
})

// Health endpoint
app.get('/health', (c: Context) => {
  const store = loadStore()
  const now = Date.now()
  const eligible = Object.values(store.accounts).filter(acc =>
    (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
    (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
    (!acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now) &&
    !acc.authInvalid &&
    acc.enabled !== false
  )
  return c.json({
    status: 'ok',
    port: PORT,
    accounts: eligible.length,
    connections: getActiveConnections()
  })
})

// Chat completions endpoint
app.post('/v1/chat/completions', async (c: Context) => {
  let body: Record<string, any>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }, 400)
  }

  if (!body.model || !body.messages?.length) {
    return c.json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } }, 400)
  }

  const normalizedModel = normalizeModel(body.model)
  const store = loadStore()
  const forceState = getForceState()
  const forcePinned = isForceActive() && !!forceState.forcedAlias
  const eligibleCount = Object.values(store.accounts).filter(acc => {
    const now = Date.now()
    return (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
           (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
           (!acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now) &&
           !acc.authInvalid &&
           acc.enabled !== false
  }).length

  const maxAttempts = forcePinned ? 1 : Math.max(1, Math.min(eligibleCount, 5))
  const triedAliases = new Set<string>()
  let attempt = 0

  while (attempt < maxAttempts) {
    attempt++

    const settings = getRuntimeSettings()
    const effectiveConfig: PluginConfig = {
      ...pluginConfig,
      rotationStrategy: settings.settings.rotationStrategy
    }

    const rotation = await getNextAccount(effectiveConfig, { model: normalizedModel })

    if (!rotation) {
      return c.json({
        error: Errors.noEligibleAccounts('No available accounts after filtering')
      }, 503)
    }

    const { account, token } = rotation
    if (triedAliases.has(account.alias)) continue
    triedAliases.add(account.alias)

    const decoded = decodeJWT(token)
    const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) {
      return c.json({
        error: { code: 'TOKEN_PARSE_ERROR', message: 'Failed to extract accountId from token' }
      }, 401)
    }

    // Build Codex request
    const messages = body.messages || []
    let instructions = 'You are a helpful assistant.'
    const input: Array<{ role: string; content: string }> = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions = msg.content
      } else {
        input.push({ role: msg.role, content: msg.content })
      }
    }

    const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)
    const codexBody: Record<string, any> = {
      model: normalizedModel,
      input,
      instructions,
      stream: true,
      store: false
    }

    if (reasoningMatch?.[1]) {
      codexBody.reasoning = { effort: reasoningMatch[1] }
      if (!isSparkModel(normalizedModel)) {
        codexBody.reasoning.summary = 'auto'
      }
    }

    if (supportsFastMode(normalizedModel)) {
      codexBody.service_tier = 'priority'
    }
    if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
      codexBody.tools = body.tools
    }
    if (body.tool_choice !== undefined) {
      codexBody.tool_choice = body.tool_choice
    }

    try {
      return await proxyRequest(c, codexBody, token, accountId, account.alias, normalizedModel)
    } catch (err: any) {
      const status = err?.status
      if (status === 401 || status === 403) {
        markAuthInvalid(account.alias)
        if (attempt < maxAttempts) continue
      }
      if (status === 429) {
        const errorData = await err?.body?.json?.().catch(() => ({})) || {}
        const errorText = extractErrorMessage(errorData)
        const rateLimitedUntil = resolveRateLimitedUntil(
          account.rateLimits,
          new Headers(),
          errorText,
          pluginConfig.rateLimitCooldownMs
        )
        markRateLimited(account.alias, rateLimitedUntil)
        if (attempt < maxAttempts) continue
      }
      if (status >= 500) {
        if (attempt < maxAttempts) continue
      }
      throw err
    }
  }

  return c.json({
    error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
  }, 502)
})

// ─── Proxy Request with SSE streaming ─────────────────────────────────

async function proxyRequest(
  c: Context,
  codexBody: object,
  token: string,
  accountId: string,
  alias: string,
  model: string
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const encoder = new TextEncoder()
    let streamEnded = false
    const abortController = new AbortController()

    const stream = new ReadableStream({
      start(controller) {
        proxyToCodex({
          body: codexBody,
          token,
          accountId,
          signal: abortController.signal,
          onEvent: (eventJson: string) => {
            if (streamEnded) return
            try {
              const event = JSON.parse(eventJson)
              const sseLine = transformSSEEvent(event)
              if (sseLine) {
                controller.enqueue(encoder.encode(sseLine))
                if (event.type === 'response.completed' || event.type === 'response.failed') {
                  streamEnded = true
                }
              }
            } catch {}
          },
          onError: (err: Error) => {
            if (!streamEnded) {
              const errorSSE = `data: ${JSON.stringify({
                error: { message: err.message, type: 'server_error' }
              })}\n\ndata: [DONE]\n\n`
              try { controller.enqueue(encoder.encode(errorSSE)) } catch {}
              streamEnded = true
            }
            try { controller.close() } catch {}
          },
          onClose: () => {
            if (!streamEnded) {
              try { controller.enqueue(encoder.encode('data: [DONE]\n\n')) } catch {}
              streamEnded = true
            }
            try { controller.close() } catch {}
          }
        }).catch(err => reject(err))
      },
      cancel() {
        abortController.abort()
        streamEnded = true
      }
    })

    c.req.raw.signal?.addEventListener('abort', () => {
      abortController.abort()
      streamEnded = true
    })

    resolve(new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    }))
  })
}

// ─── Graceful Shutdown ────────────────────────────────────────────────

let serverInstance: ServerType | null = null
let isDraining = false

function gracefulShutdown(): void {
  if (isDraining) return
  isDraining = true

  console.log(`[openai-router] Draining ${getActiveConnections()} active connections...`)
  stopHeartbeat()
  releaseLock()

  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS
  const drainCheck = setInterval(() => {
    if (getActiveConnections() === 0 || Date.now() > drainDeadline) {
      clearInterval(drainCheck)
      console.log('[openai-router] Shutdown complete')
      process.exit(0)
    }
  }, 200)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// Idle shutdown monitor
setInterval(() => {
  const idle = getIdleTimeMs()
  if (idle > IDLE_SHUTDOWN_MS && getActiveConnections() === 0) {
    console.log(`[openai-router] Idle for ${Math.round(idle / 1000)}s, shutting down`)
    gracefulShutdown()
  }
}, 5000)

// ─── Start Server ─────────────────────────────────────────────────────

startHeartbeat(PORT)

serverInstance = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`[openai-router] Listening on http://127.0.0.1:${PORT} (pid: ${process.pid})`)
})

serverInstance.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[openai-router] Port ${PORT} in use, exiting cleanly`)
    process.exit(0)
  }
  console.error('[openai-router] Server error:', err)
  process.exit(1)
})
