import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { getForceState, isForceActive } from './force-mode.js'
import { getRuntimeSettings } from './settings.js'
import { listAccounts, updateAccount, loadStore } from './store.js'
import { DEFAULT_CONFIG, type AccountRateLimits, type PluginConfig } from './types.js'
import { Errors, type DeterministicError } from './errors.js'
import {
  startHeartbeat,
  stopHeartbeat,
  connectionStart,
  connectionEnd,
  getIdleTimeMs,
  getActiveConnections,
  releaseLock
} from './heartbeat.js'
import { syncAuthFromOpenCode } from './auth-sync.js'
import { createAuthorizationFlow, loginAccount } from './auth.js'
import {
  extractRateLimitUpdate,
  getBlockingRateLimitResetAt,
  mergeRateLimits,
  parseRateLimitResetFromError,
  parseRetryAfterHeader
} from './rate-limits.js'
import {
  getNextAccount,
  markAuthInvalid,
  markModelUnsupported,
  markRateLimited,
  markWorkspaceDeactivated
} from './rotation.js'
import { getDefaultModels } from './models.js'

const PROVIDER_ID = 'openai'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const URL_PATHS = {
  RESPONSES: '/responses',
  CODEX_RESPONSES: '/codex/responses'
}
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

let pluginConfig: PluginConfig = { ...DEFAULT_CONFIG }

function configure(config: Partial<PluginConfig>): void {
  pluginConfig = { ...pluginConfig, ...config }
}

function decodeJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(decoded) as Record<string, any>
  } catch {
    return null
  }
}

function extractRequestUrl(input: Request | string | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function rewriteUrlForCodex(url: string): string {
  return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
}

function extractPathAndSearch(url: string): string {
  // OpenCode sometimes passes relative paths (e.g. "/chat/completions") or even
  // malformed strings when provider base_url is missing (e.g. "undefined/...").
  // We only need the path+query and then we force the ChatGPT backend base URL.
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    // best-effort fallback
  }

  const trimmed = String(url || '').trim()
  if (trimmed.startsWith('/')) return trimmed
  const firstSlash = trimmed.indexOf('/')
  if (firstSlash >= 0) return trimmed.slice(firstSlash)
  return trimmed
}

function toCodexBackendUrl(originalUrl: string): string {
  const pathAndSearch = extractPathAndSearch(originalUrl)

  // Map OpenAI v1 endpoints to ChatGPT Codex endpoints.
  let mapped = pathAndSearch
  if (mapped.includes(URL_PATHS.RESPONSES)) {
    mapped = mapped.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
  } else if (mapped.includes('/chat/completions')) {
    mapped = mapped.replace('/chat/completions', '/codex/chat/completions')
  }

  return new URL(mapped, CODEX_BASE_URL).toString()
}

function filterInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input
    .filter((item) => item?.type !== 'item_reference')
    .map((item) => {
      if (item && typeof item === 'object' && 'id' in item) {
        const { id, ...rest } = item as Record<string, unknown>
        return rest
      }
      return item
    })
}

function normalizeModel(model: string | undefined): string {
  if (!model) return 'gpt-5.1'

  const modelId = model.includes('/') ? model.split('/').pop()! : model
  const baseModel = modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '')

  // OpenCode may lag behind the ChatGPT Codex model allowlist. Route known older
  // Codex selections to the latest backend model when users opt in.
  const preferLatestRaw = process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST
  const preferLatest = preferLatestRaw === '1' || preferLatestRaw === 'true'

  if (
    preferLatest &&
    (
      baseModel === 'gpt-5.4' ||
      baseModel === 'gpt-5.3-codex' ||
      baseModel === 'gpt-5.2-codex' ||
      baseModel === 'gpt-5-codex'
    )
  ) {
    const latestModel = (
      process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || DEFAULT_LATEST_CODEX_MODEL
    ).trim()

    if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
      console.log(`[multi-auth] model map: ${baseModel} -> ${latestModel}`)
    }

    return latestModel
  }

  return baseModel
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.5' || model === 'gpt-5.4'
}

function ensureContentType(headers: Headers): Headers {
  const responseHeaders = new Headers(headers)
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8')
  }
  return responseHeaders
}

function extractErrorMessage(payload: any, fallbackText: string = ''): string {
  if (!payload || typeof payload !== 'object') {
    return fallbackText
  }

  const detailMessage = typeof payload?.detail?.message === 'string'
    ? payload.detail.message
    : typeof payload?.detail === 'string'
      ? payload.detail
      : ''

  const errorMessage = typeof payload?.error?.message === 'string'
    ? payload.error.message
    : ''

  const topLevelMessage = typeof payload?.message === 'string'
    ? payload.message
    : ''

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
  const windowResetUntil =
    getBlockingRateLimitResetAt(rateLimits, now, {
      conservativeWhenRemainingUnknown: true
    }) || 0
  const messageResetUntil = parseRateLimitResetFromError(errorText, now) || 0
  const fallbackUntil = now + fallbackCooldownMs

  return Math.max(fallbackUntil, retryAfterUntil, windowResetUntil, messageResetUntil)
}

function parseSseStream(sseText: string): unknown | null {
  const lines = sseText.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.substring(6)) as { type?: string; response?: unknown }
      if (data?.type === 'response.done' || data?.type === 'response.completed') {
        return data.response
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return null
}

async function convertSseToJson(response: Response, headers: Headers): Promise<Response> {
  if (!response.body) {
    throw new Error('[multi-auth] Response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    fullText += decoder.decode(value, { stream: true })
  }

  const finalResponse = parseSseStream(fullText)
  if (!finalResponse) {
    return new Response(fullText, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }

  const jsonHeaders = new Headers(headers)
  jsonHeaders.set('content-type', 'application/json; charset=utf-8')

  return new Response(JSON.stringify(finalResponse), {
    status: response.status,
    statusText: response.statusText,
    headers: jsonHeaders
  })
}

// ─── Inline Router Server ───────────────────────────────────────────────

const ROUTER_PORT = Number(process.env.OPENCODE_MULTI_AUTH_ROUTER_PORT || 47990)
let routerServer: ServerType | null = null

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

function startInlineRouter(): ServerType {
  const app = new Hono()
  let pluginConf: PluginConfig = { ...DEFAULT_CONFIG }

  // Local helpers (avoid duplicate top-level definitions)
  const localDecodeJWT = (token: string): Record<string, any> | null => {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return null
      return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'))
    } catch { return null }
  }

  const localNormalizeModel = (model: string | undefined): string => {
    if (!model) return 'gpt-5.1'
    const modelId = model.includes('/') ? model.split('/').pop()! : model
    return modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '')
  }

  const localIsSparkModel = (model: string | undefined): boolean => {
    return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
  }

  const localSupportsFastMode = (model: string | undefined): boolean => {
    return model === 'gpt-5.5' || model === 'gpt-5.4'
  }

  function localTransformSSEEvent(codexEvent: { type: string; [key: string]: any }): string | null {
    switch (codexEvent.type) {
      case 'response.output_text.delta': {
        const chunk = {
          id: codexEvent.item_id?.replace('msg_', 'chatcmpl-') || 'chatcmpl-codex',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-5.4',
          choices: [{ index: 0, delta: { content: codexEvent.delta || '' }, finish_reason: null }]
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

  app.use('*', async (c, next) => {
    connectionStart()
    try { await next() } finally { connectionEnd() }
  })

  app.get('/health', (c) => {
    const store = loadStore()
    const now = Date.now()
    const eligible = Object.values(store.accounts).filter(acc =>
      (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
      (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
      (!acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now) &&
      !acc.authInvalid && acc.enabled !== false
    )
    return c.json({ status: 'ok', port: ROUTER_PORT, accounts: eligible.length, connections: getActiveConnections() })
  })

  app.post('/v1/chat/completions', async (c) => {
    let body: Record<string, any>
    try { body = await c.req.json() } catch {
      return c.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }, 400)
    }
    if (!body.model || !body.messages?.length) {
      return c.json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } }, 400)
    }

    const normalizedModel = localNormalizeModel(body.model)
    const settings = getRuntimeSettings()
    const effectiveConfig: PluginConfig = { ...pluginConf, rotationStrategy: settings.settings.rotationStrategy }
    const maxAttempts = 5
    const triedAliases = new Set<string>()
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt++
      const rotation = await getNextAccount(effectiveConfig, { model: normalizedModel })
      if (!rotation) {
        return c.json({ error: Errors.noEligibleAccounts('No available accounts') }, 503)
      }
      const { account, token } = rotation
      if (triedAliases.has(account.alias)) continue
      triedAliases.add(account.alias)

      const decoded = localDecodeJWT(token)
      const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id
      if (!accountId) {
        return c.json({ error: { code: 'TOKEN_PARSE_ERROR', message: 'Failed to extract accountId' } }, 401)
      }

      const messages = body.messages || []
      let instructions = 'You are a helpful assistant.'
      const input: Array<{ role: string; content: string }> = []
      for (const msg of messages) {
        if (msg.role === 'system') instructions = msg.content
        else input.push({ role: msg.role, content: msg.content })
      }

      const codexBody: Record<string, any> = { model: normalizedModel, input, instructions, stream: true, store: false }
      const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)
      if (reasoningMatch?.[1]) {
        codexBody.reasoning = { effort: reasoningMatch[1] }
        if (!localIsSparkModel(normalizedModel)) codexBody.reasoning.summary = 'auto'
      }
      if (localSupportsFastMode(normalizedModel)) codexBody.service_tier = 'priority'

      try {
        const encoder = new TextEncoder()
        let streamEnded = false
        const abortController = new AbortController()

        const stream = new ReadableStream({
          start(controller) {
            fetch(CODEX_RESPONSES_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'responses=experimental',
                'chatgpt-account-id': accountId,
                'originator': 'codex_cli_rs',
                'Accept': 'text/event-stream'
              },
              body: JSON.stringify(codexBody),
              signal: abortController.signal
            }).then(async (res) => {
              if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText)
                if (res.status === 401 || res.status === 403) markAuthInvalid(account.alias)
                if (res.status === 429) markRateLimited(account.alias, Date.now() + 60000)
                if (!streamEnded) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `Codex ${res.status}: ${errText}`, type: 'server_error' } })}\n\ndata: [DONE]\n\n`))
                  streamEnded = true
                }
                controller.close()
                return
              }
              if (!res.body) { controller.close(); return }
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
                  let eventType = '', eventData = ''
                  for (const line of lines) {
                    if (line.startsWith('event: ')) eventType = line.slice(7)
                    else if (line.startsWith('data: ')) eventData = line.slice(6)
                  }
                  if (eventType && eventData) {
                    try {
                      const parsed = JSON.parse(eventData)
                      const sse = localTransformSSEEvent({ type: eventType, ...parsed })
                      if (sse && !streamEnded) {
                        controller.enqueue(encoder.encode(sse))
                        if (eventType === 'response.completed' || eventType === 'response.failed') streamEnded = true
                      }
                    } catch {}
                  }
                }
              }
              if (!streamEnded) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }).catch((err) => {
              if (!streamEnded) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\ndata: [DONE]\n\n`))
                streamEnded = true
              }
              try { controller.close() } catch {}
            })
          },
          cancel() { abortController.abort(); streamEnded = true }
        })

        c.req.raw.signal?.addEventListener('abort', () => { abortController.abort(); streamEnded = true })

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }
        })
      } catch (err: any) {
        const status = err?.status
        if (status === 401 || status === 403) { markAuthInvalid(account.alias); if (attempt < maxAttempts) continue }
        if (status >= 500) { if (attempt < maxAttempts) continue }
        throw err
      }
    }
    return c.json({ error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)) }, 502)
  })

  startHeartbeat(ROUTER_PORT)

  const srv = serve({ fetch: app.fetch, port: ROUTER_PORT, hostname: '127.0.0.1' }, () => {
    console.log(`[openai-router] Router listening on http://127.0.0.1:${ROUTER_PORT}`)
  })
  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[openai-router] Port ${ROUTER_PORT} in use, router not started (another instance running)`)
    } else {
      console.error('[openai-router] Router error:', err)
    }
  })
  return srv
}

import { appendFileSync } from 'node:fs'
const ERROR_LOG = '/tmp/openai-router-errors.log'
function errorLog(msg: string) {
  try { appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// ─── Web Dashboard Management ──────────────────────────────────────────────

const WEB_PORT = Number(process.env.OPENCODE_MULTI_AUTH_WEB_PORT || 3434)
const WEB_HOST = process.env.OPENCODE_MULTI_AUTH_WEB_HOST || '0.0.0.0'
let webProcess: ReturnType<typeof spawn> | null = null

async function checkWebHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/`, {
      signal: AbortSignal.timeout(500)
    })
    return res.ok
  } catch { return false }
}

function startWebDashboard(): void {
  const webScript = join(__dirname, 'cli.js')
  errorLog(`Starting web dashboard: ${process.execPath} ${webScript} web --port ${WEB_PORT} --host ${WEB_HOST}`)

  const child = spawn('node', [webScript, 'web', '--port', String(WEB_PORT), '--host', WEB_HOST], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: __dirname,
    windowsHide: true,
    env: { ...process.env }
  })
  child.unref()
  child.stdout?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    errorLog(`[web stdout] ${msg}`)
    console.log(`[openai-router:web] ${msg}`)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    errorLog(`[web stderr] ${msg}`)
    console.error(`[openai-router:web] ${msg}`)
  })
  child.on('error', (err) => {
    errorLog(`[web spawn error] ${err.message}`)
  })
  child.on('close', (code) => {
    errorLog(`[web process exited] code=${code}`)
  })
  webProcess = child
}

async function ensureWebRunning(): Promise<void> {
  errorLog('ensureWebRunning: checking if dashboard is already running...')
  if (await checkWebHealth()) {
    errorLog('ensureWebRunning: dashboard already running')
    console.log(`[openai-router] Web dashboard already running on port ${WEB_PORT}`)
    return
  }
  errorLog('ensureWebRunning: starting dashboard...')
  console.log(`[openai-router] Starting web dashboard on ${WEB_HOST}:${WEB_PORT}...`)
  startWebDashboard()

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await checkWebHealth()) {
      errorLog('ensureWebRunning: dashboard ready')
      console.log(`[openai-router] Web dashboard ready on http://${WEB_HOST}:${WEB_PORT}`)
      return
    }
    await new Promise(r => setTimeout(r, 300))
  }
  errorLog('ensureWebRunning: dashboard did not become ready within 5s')
  console.log('[openai-router] Web dashboard may still be starting...')
}

/**
 * Multi-account OAuth plugin for OpenCode
 *
 * Rotates between multiple ChatGPT Plus/Pro accounts for rate limit resilience.
 */
const MultiAuthPlugin: Plugin = async ({ client, $, serverUrl, project, directory }: PluginInput) => {
  const terminalNotifierPath = (() => {
    const candidates = [
      '/opt/homebrew/bin/terminal-notifier',
      '/usr/local/bin/terminal-notifier'
    ]
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        // ignore
      }
    }
    return null
  })()

  const notifyEnabledRaw = process.env.OPENCODE_MULTI_AUTH_NOTIFY
  const notifyEnabled = notifyEnabledRaw === '1' || notifyEnabledRaw === 'true'
  const notifySound = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_SOUND || '/System/Library/Sounds/Glass.aiff').trim()

  const lastStatusBySession = new Map<string, string>()
  const lastNotifiedAtByKey = new Map<string, number>()
  const lastRetryAttemptBySession = new Map<string, number>()

  const escapeAppleScriptString = (value: string): string => {
    return String(value)
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\"')
      .replaceAll(String.fromCharCode(10), '\n')
  }

  let didWarnTerminalNotifier = false

  const notifyMac = (title: string, message: string, clickUrl?: string): void => {
    if (!notifyEnabled) return
    if (process.platform !== 'darwin') return

    const macOpenRaw = process.env.OPENCODE_MULTI_AUTH_NOTIFY_MAC_OPEN
    const macOpenEnabled = macOpenRaw !== '0' && macOpenRaw !== 'false'

    // Best effort: clickable notifications require terminal-notifier.
    if (macOpenEnabled && clickUrl && terminalNotifierPath) {
      try {
        $`${terminalNotifierPath} -title ${title} -message ${message} -open ${clickUrl}`
          .nothrow()
          .catch(() => {})
      } catch {
        // ignore
      }
    } else {
      if (macOpenEnabled && clickUrl && !terminalNotifierPath && !didWarnTerminalNotifier) {
        didWarnTerminalNotifier = true
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log('[multi-auth] mac click-to-open requires terminal-notifier (brew install terminal-notifier)')
        }
      }

      try {
        const osascript = '/usr/bin/osascript'
        const safeTitle = escapeAppleScriptString(title)
        const safeMessage = escapeAppleScriptString(message)
        const script = `display notification "${safeMessage}" with title "${safeTitle}"`

        // Fire-and-forget: never block OpenCode event processing.
        $`${osascript} -e ${script}`.nothrow().catch(() => {})
      } catch {
        // ignore
      }
    }

    if (!notifySound) return

    try {
      const afplay = '/usr/bin/afplay'
      $`${afplay} ${notifySound}`.nothrow().catch(() => {})
    } catch {
      // ignore
    }
  }


  const ntfyUrl = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_NTFY_URL || '').trim()
  const ntfyToken = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_NTFY_TOKEN || '').trim()
  const notifyUiBaseUrl = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_UI_BASE_URL || '').trim()

  const getSessionUrl = (sessionID: string): string => {
    const base = (notifyUiBaseUrl || serverUrl?.origin || '').replace(/\/$/, '')
    if (!base) return ''
    return `${base}/session/${sessionID}`
  }



  const projectLabel = (((project as any)?.name as string | undefined) || project?.id || '').trim() || 'OpenCode'

  type SessionMeta = { title?: string }
  const sessionMetaCache = new Map<string, SessionMeta>()

  const formatTitle = (kind: 'idle' | 'retry' | 'error'): string => {
    if (kind === 'error') return `OpenCode - ${projectLabel} - Error`
    if (kind === 'retry') return `OpenCode - ${projectLabel} - Retrying`
    return `OpenCode - ${projectLabel}`
  }

  const formatBody = (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): string => {
    const meta = sessionMetaCache.get(sessionID) || {}
    const titleLine = meta.title ? `Task: ${meta.title}` : ''
    const url = getSessionUrl(sessionID)

    if (kind === 'idle') {
      return [titleLine, `Session finished: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
    }

    if (kind === 'retry') {
      return [titleLine, `Retrying: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
    }

    return [titleLine, `Error: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
  }

  const notifyMacRich = (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): void => {
    const body = formatBody(kind, sessionID, detail)
    notifyMac(formatTitle(kind), body, getSessionUrl(sessionID) || undefined)
  }

  const notifyNtfyRich = async (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): Promise<void> => {
    if (!notifyEnabled) return
    if (!ntfyUrl) return

    const sessionUrl = getSessionUrl(sessionID)
    const title = formatTitle(kind)
    const body = formatBody(kind, sessionID, detail)

    // ntfy priority: 1=min, 3=default, 5=max
    const priority = kind === 'error' ? '5' : kind === 'retry' ? '4' : '3'

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': title,
      'Priority': priority
    }

    if (sessionUrl) headers['Click'] = sessionUrl
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`

    try {
      await fetch(ntfyUrl, { method: 'POST', headers, body })
    } catch {
      // ignore
    }
  }
  const shouldThrottle = (key: string, minMs: number): boolean => {
    const last = lastNotifiedAtByKey.get(key) || 0
    const now = Date.now()
    if (now - last < minMs) return true
    lastNotifiedAtByKey.set(key, now)
    return false
  }

  const formatRetryDetail = (status: any): string => {
    const attempt = typeof status?.attempt === 'number' ? status.attempt : undefined
    const message = typeof status?.message === 'string' ? status.message : ''
    const next = typeof status?.next === 'number' ? status.next : undefined

    const parts: string[] = []
    if (typeof attempt === 'number') parts.push(`Attempt: ${attempt}`)
    // OpenCode has emitted both "seconds-until-next" and "epoch ms" variants over time.
    if (typeof next === 'number') {
      const seconds =
        next > 1e12 ? Math.max(0, Math.round((next - Date.now()) / 1000)) : Math.max(0, Math.round(next))
      parts.push(`Next in: ${seconds}s`)
    }
    if (message) parts.push(message)
    return parts.join(' | ')
  }

  const formatErrorDetail = (err: any): string => {
    if (!err || typeof err !== 'object') return ''
    const name = typeof err.name === 'string' ? err.name : ''
    const code = typeof err.code === 'string' ? err.code : ''
    const message =
      (typeof err.message === 'string' && err.message) ||
      (typeof err.error?.message === 'string' && err.error.message) ||
      ''
    return [name, code, message].filter(Boolean).join(': ')
  }

  const notifyRich = async (
    kind: 'idle' | 'retry' | 'error',
    sessionID: string,
    detail?: string
  ): Promise<void> => {
    try {
      notifyMacRich(kind, sessionID, detail)
    } catch {
      // ignore
    }

    try {
      await notifyNtfyRich(kind, sessionID, detail)
    } catch {
      // ignore
    }
  }

  // Start inline router
  try {
    routerServer = startInlineRouter()
  } catch (e) {
    console.log('[openai-router] Router start failed, another instance may be running')
  }

  // Start web dashboard
  await ensureWebRunning()

  return {
    event: async ({ event }) => {
      if (!notifyEnabled) return
      if (!event || !('type' in event)) return

      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = (event as any).properties?.info as
          | { id?: string; title?: string }
          | undefined
        const id = info?.id
        if (id) {
          sessionMetaCache.set(id, { title: info?.title })
        }
        return
      }

      if (event.type === 'session.status') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        const status = (event as any).properties?.status
        const statusType = status?.type as string | undefined
        if (!sessionID || !statusType) return

        lastStatusBySession.set(sessionID, statusType)

        if (statusType === 'retry') {
          const attempt = typeof status?.attempt === 'number' ? status.attempt : undefined
          const prevAttempt = lastRetryAttemptBySession.get(sessionID)

          if (typeof attempt === 'number') {
            if (prevAttempt === attempt && shouldThrottle(`retry:${sessionID}:${attempt}`, 5000)) {
              return
            }
            lastRetryAttemptBySession.set(sessionID, attempt)
          }

          const key = `retry:${sessionID}:${typeof attempt === 'number' ? attempt : 'na'}`
          if (shouldThrottle(key, 2000)) return

          void notifyRich('retry', sessionID, formatRetryDetail(status))
        }

        return
      }

      if (event.type === 'session.error') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        const id = sessionID || 'unknown'
        const err = (event as any).properties?.error
        const detail = formatErrorDetail(err)
        const key = `error:${id}:${detail}`
        if (shouldThrottle(key, 2000)) return
        void notifyRich('error', id, detail)
        return
      }

      if (event.type === 'session.idle') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        if (!sessionID) return

        const prev = lastStatusBySession.get(sessionID)
        if (prev === 'busy' || prev === 'retry') {
          if (shouldThrottle(`idle:${sessionID}`, 2000)) return
          void notifyRich('idle', sessionID)
        }

        lastStatusBySession.set(sessionID, 'idle')
      }
    },
    config: async (config) => {
      const injectModelsRaw = process.env.OPENCODE_MULTI_AUTH_INJECT_MODELS
      const injectModels = injectModelsRaw === '1' || injectModelsRaw === 'true'
      if (!injectModels) return

      const latestModel = (process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || DEFAULT_LATEST_CODEX_MODEL).trim()
      try {
        const openai = (config.provider?.[PROVIDER_ID] as any) || null
        if (!openai || typeof openai !== 'object') return
        openai.models ||= {}
        openai.whitelist ||= []

        const defaultModels = getDefaultModels()
        const injectedModelIds = [latestModel]
        if (supportsFastMode(latestModel) && defaultModels[`${latestModel}-fast`]) {
          injectedModelIds.push(`${latestModel}-fast`)
        }
        for (const sparkVariant of [
          'gpt-5.3-codex-spark-low',
          'gpt-5.3-codex-spark-medium',
          'gpt-5.3-codex-spark-high',
          'gpt-5.3-codex-spark-xhigh'
        ]) {
          if (defaultModels[sparkVariant]) {
            injectedModelIds.push(sparkVariant)
          }
        }

        for (const modelID of injectedModelIds) {
          const model = defaultModels[modelID]
          if (!model || openai.models[modelID]) continue
          openai.models[modelID] = model
        }

        for (const modelID of injectedModelIds) {
          if (!openai.whitelist.includes(modelID)) {
            openai.whitelist.unshift(modelID)
          }
        }

        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log(`[multi-auth] injected runtime models: ${injectedModelIds.join(', ')}`)
        }
      } catch (err) {
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log('[multi-auth] config injection failed:', err)
        }
      }
    },

    auth: {
      provider: PROVIDER_ID,

      /**
       * Loader configures the SDK with multi-account rotation
       */
      async loader(getAuth, provider) {
        await syncAuthFromOpenCode(getAuth)
        const accounts = listAccounts()

        if (accounts.length === 0) {
          console.log('[multi-auth] No accounts configured. Run: opencode-multi-auth add <alias>')
          return {}
        }

        const customFetch = async (
          input: Request | string | URL,
          init?: RequestInit
        ): Promise<Response> => {
          await syncAuthFromOpenCode(getAuth)

          let body: Record<string, any> = {}
          try {
            body = init?.body ? JSON.parse(init.body as string) : {}
          } catch {
            body = {}
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
          
          const maxAttempts = forcePinned ? 1 : Math.max(1, eligibleCount)
          const triedAliases = new Set<string>()
          let attempt = 0

          while (attempt < maxAttempts) {
            attempt++
            
            const settings = getRuntimeSettings()
            const effectiveConfig: PluginConfig = {
              ...pluginConfig,
              rotationStrategy: settings.settings.rotationStrategy
            }

            const rotation = await getNextAccount(effectiveConfig, {
              model: normalizedModel
            })

            if (!rotation) {
              if (forcePinned && forceState.forcedAlias) {
                const forced = loadStore().accounts[forceState.forcedAlias]
                const now = Date.now()
                if (forced?.rateLimitedUntil && forced.rateLimitedUntil > now) {
                  return new Response(
                    JSON.stringify({
                      error: {
                        code: 'RATE_LIMITED',
                        message: `Forced account '${forced.alias}' is rate-limited until ${new Date(forced.rateLimitedUntil).toISOString()}`,
                        details: { alias: forced.alias, rateLimitedUntil: forced.rateLimitedUntil }
                      }
                    }),
                    { status: 429, headers: { 'Content-Type': 'application/json' } }
                  )
                }
              }
              return new Response(
                JSON.stringify({ 
                  error: Errors.noEligibleAccounts('No available accounts after filtering')
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
              )
            }

            const { account, token } = rotation
            
            if (triedAliases.has(account.alias)) {
              continue
            }
            triedAliases.add(account.alias)

            const decoded = decodeJWT(token)
            const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id
            if (!accountId) {
              return new Response(
                JSON.stringify({ 
                  error: { 
                    code: 'TOKEN_PARSE_ERROR',
                    message: '[multi-auth] Failed to extract accountId from token' 
                  }
                }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
              )
            }

            const originalUrl = extractRequestUrl(input)
            const url = toCodexBackendUrl(originalUrl)

            const isStreaming = body?.stream === true
            const fastMode = /-fast$/.test(body.model || '')
            const supportedFastMode = fastMode && supportsFastMode(normalizedModel)
            const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)

            const payload: Record<string, any> = {
              ...body,
              model: normalizedModel,
              store: false
            }

            if (payload.truncation === undefined) {
              const truncationRaw = (process.env.OPENCODE_MULTI_AUTH_TRUNCATION || '').trim()
              if (truncationRaw && truncationRaw !== 'disabled' && truncationRaw !== 'false' && truncationRaw !== '0') {
                payload.truncation = truncationRaw
              }
            }

            if (payload.input) {
              payload.input = filterInput(payload.input)
            }

            if (reasoningMatch?.[1]) {
              payload.reasoning = {
                ...(payload.reasoning || {}),
                effort: reasoningMatch[1]
              }

              if (!isSparkModel(normalizedModel)) {
                payload.reasoning.summary = payload.reasoning?.summary || 'auto'
              }
            }

            if (isSparkModel(normalizedModel) && payload.reasoning?.summary !== undefined) {
              delete payload.reasoning.summary
            }

            if (supportedFastMode) {
              payload.service_tier = payload.service_tier || 'priority'

              if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
                console.log(`[multi-auth] fast mode enabled: ${normalizedModel} + service_tier=priority`)
              }
            } else if (fastMode && process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
              console.log(`[multi-auth] fast mode ignored for unsupported model: ${normalizedModel}`)
            }

            if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1' && payload.service_tier === 'priority') {
              console.log(`[multi-auth] priority service tier requested for ${normalizedModel}`)
            }

            delete payload.reasoning_effort

            try {
              const headers = new Headers(init?.headers || {})
              headers.delete('x-api-key')
              headers.set('Content-Type', 'application/json')
              headers.set('Authorization', `Bearer ${token}`)
              headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId)
              headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES)
              headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX)

              const cacheKey = payload?.prompt_cache_key
              if (cacheKey) {
                headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey)
                headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey)
              } else {
                headers.delete(OPENAI_HEADERS.CONVERSATION_ID)
                headers.delete(OPENAI_HEADERS.SESSION_ID)
              }

              headers.set('accept', 'text/event-stream')

              const res = await fetch(url, {
                method: init?.method || 'POST',
                headers,
                body: JSON.stringify(payload)
              })

              const limitUpdate = extractRateLimitUpdate(res.headers)
              const mergedRateLimits = limitUpdate
                ? mergeRateLimits(account.rateLimits, limitUpdate)
                : account.rateLimits
              if (limitUpdate) {
                const blockingResetAt = getBlockingRateLimitResetAt(mergedRateLimits)
                updateAccount(account.alias, {
                  rateLimits: mergedRateLimits,
                  rateLimitedUntil: blockingResetAt
                })
              }

              if (res.status === 401 || res.status === 403) {
                const errorData = await res.clone().json().catch(() => ({})) as { error?: { message?: string } }
                const message = errorData?.error?.message || ''
                if (message.toLowerCase().includes('invalidated') || res.status === 401) {
                  markAuthInvalid(account.alias)
                }

                if (attempt < maxAttempts) {
                  continue
                }

                return new Response(
                  JSON.stringify({
                    error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
                  }),
                  { status: res.status, headers: { 'Content-Type': 'application/json' } }
                )
              }

              if (res.status === 429) {
                const errorData = await res.clone().json().catch(() => ({})) as any
                const errorText = extractErrorMessage(errorData)
                const rateLimitedUntil = resolveRateLimitedUntil(
                  mergedRateLimits,
                  res.headers,
                  errorText,
                  pluginConfig.rateLimitCooldownMs
                )
                markRateLimited(account.alias, rateLimitedUntil)

                if (attempt < maxAttempts) {
                  continue
                }

                return new Response(
                  JSON.stringify({
                    error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
                  }),
                  { status: 429, headers: { 'Content-Type': 'application/json' } }
                )
              }

              if (res.status === 402) {
                const errorData = await res.clone().json().catch(() => null) as any
                const errorText = await res.clone().text().catch(() => '')

                const code =
                  (typeof errorData?.detail?.code === 'string' && errorData.detail.code) ||
                  (typeof errorData?.error?.code === 'string' && errorData.error.code) ||
                  ''
                const message =
                  (typeof errorData?.detail?.message === 'string' && errorData.detail.message) ||
                  (typeof errorData?.detail === 'string' && errorData.detail) ||
                  (typeof errorData?.error?.message === 'string' && errorData.error.message) ||
                  (typeof errorData?.message === 'string' && errorData.message) ||
                  errorText ||
                  ''

                const isDeactivatedWorkspace =
                  code === 'deactivated_workspace' ||
                  message.toLowerCase().includes('deactivated_workspace') ||
                  message.toLowerCase().includes('deactivated workspace')

                if (isDeactivatedWorkspace) {
                  markWorkspaceDeactivated(account.alias, pluginConfig.workspaceDeactivatedCooldownMs, {
                    error: message || code
                  })

                  if (attempt < maxAttempts) {
                    continue
                  }

                  return new Response(
                    JSON.stringify({
                      error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
                    }),
                    { status: 402, headers: { 'Content-Type': 'application/json' } }
                  )
                }
              }

              if (res.status === 400) {
                const errorData = await res.clone().json().catch(() => ({})) as any
                const message =
                  (typeof errorData?.detail === 'string' && errorData.detail) ||
                  (typeof errorData?.error?.message === 'string' && errorData.error.message) ||
                  (typeof errorData?.message === 'string' && errorData.message) ||
                  ''

                const isModelUnsupported =
                  typeof message === 'string' &&
                  message.toLowerCase().includes('model is not supported') &&
                  message.toLowerCase().includes('chatgpt account')

                if (isModelUnsupported) {
                  markModelUnsupported(account.alias, pluginConfig.modelUnsupportedCooldownMs, {
                    model: normalizedModel,
                    error: message
                  })

                  if (attempt < maxAttempts) {
                    continue
                  }

                  return new Response(
                    JSON.stringify({
                      error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                  )
                }
              }

              if (!res.ok) {
                return res
              }

              const responseHeaders = ensureContentType(res.headers)
              if (!isStreaming && responseHeaders.get('content-type')?.includes('text/event-stream')) {
                return await convertSseToJson(res, responseHeaders)
              }

              return res
            } catch (err) {
              return new Response(
                JSON.stringify({ error: { code: 'REQUEST_FAILED', message: `[multi-auth] Request failed: ${err}` } }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
              )
            }
          }

          return new Response(
            JSON.stringify({ 
              error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases))
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
        }

        // Return SDK configuration with custom fetch for rotation
        return {
          apiKey: 'chatgpt-oauth',
          baseURL: CODEX_BASE_URL,
          fetch: customFetch
        }
      },

      methods: [
        {
          label: 'ChatGPT OAuth (Multi-Account)',
          type: 'oauth' as const,

          prompts: [
            {
              type: 'text' as const,
              key: 'alias',
              message: 'Account alias (e.g., personal, work)',
              placeholder: 'personal'
            }
          ],

          /**
           * OAuth flow - opens browser for ChatGPT login
           */
          authorize: async (inputs?: Record<string, string>) => {
            const alias = inputs?.alias || `account-${Date.now()}`
            const flow = await createAuthorizationFlow()

            return {
              url: flow.url,
              method: 'auto' as const,
              instructions: `Login with your ChatGPT Plus/Pro account for "${alias}"`,

              callback: async () => {
                try {
                  const account = await loginAccount(alias, flow)
                  return {
                    type: 'success' as const,
                    provider: PROVIDER_ID,
                    refresh: account.refreshToken,
                    access: account.accessToken,
                    expires: account.expiresAt
                  }
                } catch {
                  return { type: 'failed' as const }
                }
              }
            }
          }
        },
        {
          label: 'Skip (use existing accounts)',
          type: 'api' as const
        }
      ]
    }
  }
}

export default MultiAuthPlugin
