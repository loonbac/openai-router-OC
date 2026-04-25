# Exploration: Embedded HTTP Proxy Router

## Context

The plugin provides multi-account OAuth rotation for ChatGPT/Codex via OpenCode's plugin SDK. However, OpenCode ignores the `fetch` returned by the auth `loader`, so requests never go through the rotation logic. The solution is to embed an HTTP server that acts as a proxy, receiving OpenAI-format requests and forwarding them to the Codex API using the same account store and rotation logic.

---

## 1. How the Existing Auth Loader Works and Why It Fails

### Plugin Entry Point (`src/index.ts`)

The plugin exports a `Plugin` object with three hooks:

```typescript
const MultiAuthPlugin: Plugin = async ({ client, $, serverUrl, project, directory }: PluginInput) => {
  return {
    event: async ({ event }) => { /* session status tracking + notifications */ },
    config: async (config) => { /* inject runtime models into OpenCode config */ },
    auth: {
      provider: PROVIDER_ID,  // 'openai'
      async loader(getAuth, provider) { /* returns { apiKey, baseURL, fetch } */ },
      methods: [ /* OAuth flow definitions */ ]
    }
  }
}
```

### Auth Loader (`index.ts` lines 594–931)

The `loader` function:
1. Calls `syncAuthFromOpenCode(getAuth)` to sync OpenCode's current auth into the local store
2. Loads accounts via `listAccounts()`
3. Returns `{ apiKey, baseURL, fetch: customFetch }` where `customFetch` is a complex async function that:
   - Normalizes the model name
   - Calls `getNextAccount()` from `rotation.ts` to select an account
   - Extracts `accountId` from the JWT
   - Rewrites the URL from OpenAI format to Codex format
   - Adds required headers (`Authorization: Bearer <token>`, `chatgpt-account-id`, `OpenAI-Beta`, `originator`)
   - Handles errors (401/403 → `markAuthInvalid`, 429 → `markRateLimited`, 402 → `markWorkspaceDeactivated`, 400 → `markModelUnsupported`)
   - Retries with next eligible account up to `maxAttempts` times
   - Returns SSE responses directly (or converts to JSON for non-streaming)

### Why It Fails

OpenCode's plugin SDK does not use the `fetch` returned from the auth loader. The SDK sends requests directly to OpenAI's API using the `apiKey` and `baseURL` from the returned config. The `customFetch` is never called. This is why the plugin needs an embedded HTTP server—the SDK architecture bypasses the custom fetch entirely.

### Key Constants

- `PROVIDER_ID = 'openai'`
- `CODEX_BASE_URL = 'https://chatgpt.com/backend-api'`
- `URL_PATHS.RESPONSES = '/responses'` → `URL_PATHS.CODEX_RESPONSES = '/codex/responses'`
- OpenAI's `/chat/completions` → Codex's `/codex/chat/completions`
- `JWT_CLAIM_PATH = 'https://api.openai.com/auth'` — the claim path inside the JWT that contains `chatgpt_account_id`

---

## 2. How `store.ts` and `rotation.ts` Manage Accounts

### Store (`src/store.ts`)

- **Location**: `~/.config/opencode-multi-auth/accounts.json` (override via `OPENCODE_MULTI_AUTH_STORE_DIR`/`OPENCODE_MULTI_AUTH_STORE_FILE`)
- **Encrypted**: Optionally AES-256-GCM encrypted with passphrase from `CODEX_SOFT_STORE_PASSPHRASE`
- **Schema**: `AccountStore` (version 2) containing:
  - `accounts: Record<string, AccountCredentials>` — keyed by alias
  - `activeAlias: string | null`
  - `rotationIndex: number`
  - `lastRotation: number`
  - `forcedAlias`, `forcedUntil`, `forcedBy` — force mode state
  - `rotationStrategy` — current strategy
  - `settings: RotationSettings` — thresholds, weights, feature flags

**Key exports**:
- `loadStore()` / `saveStore(store)` — read/write JSON file
- `addAccount(alias, creds)` — add new account
- `updateAccount(alias, updates)` — partial update (rate limits, usage counts, etc.)
- `removeAccount(alias)` — delete account
- `listAccounts()` → `AccountCredentials[]`
- `getActiveAccount()` → current active account or null
- `getStoreDiagnostics()` → locked/encrypted/error state

**AccountCredentials fields** (from `types.ts`):
```typescript
interface AccountCredentials {
  alias: string
  accessToken: string        // OAuth access token
  refreshToken: string        // OAuth refresh token
  idToken?: string
  accountId?: string          // chatgpt_account_id from JWT claims
  accountUserId?: string
  userId?: string
  planType?: string           // 'pro' | 'plus' | ...
  expiresAt: number            // Unix timestamp
  email?: string
  lastRefresh?: string
  lastSeenAt?: number
  lastActiveUntil?: number
  lastUsed?: number
  usageCount: number
  rateLimitedUntil?: number    // Blocked until this timestamp
  modelUnsupportedUntil?: number
  workspaceDeactivatedUntil?: number
  authInvalid?: boolean
  enabled?: boolean            // Phase D: defaults to true
  rateLimits?: AccountRateLimits  // { fiveHour?, weekly? }
  rateLimitHistory?: RateLimitHistoryEntry[]
  limitsConfidence?: 'fresh' | 'stale' | 'error' | 'unknown'
  tags?: string[]
  notes?: string
  source?: 'opencode' | 'codex'
}
```

### Rotation (`src/rotation.ts`)

- `getNextAccount(config, selection?)` → `RotationResult | null`
  - Handles force mode (Phase E): if active, only uses the forced alias
  - Selects healthy accounts (not rate-limited, not blocked, not disabled)
  - Prefers Pro accounts over non-Pro
  - Applies strategy: `round-robin` (default), `least-used`, `random`, `weighted-round-robin` (Phase F)
  - For `weighted-round-robin`: uses `calculateWeightedSelection()` from settings
  - Calls `ensureValidToken(alias)` from `auth.ts` to refresh if needed
  - Updates `usageCount`, `lastUsed` on the selected account

- Mark functions (all call `updateAccount`):
  - `markRateLimited(alias, until)` — set `rateLimitedUntil`
  - `markModelUnsupported(alias, cooldownMs, info)` — set `modelUnsupportedUntil`
  - `markWorkspaceDeactivated(alias, cooldownMs, info)` — set `workspaceDeactivatedUntil`
  - `markAuthInvalid(alias)` — set `authInvalid: true`

- Clear functions: `clearRateLimit`, `clearModelUnsupported`, `clearWorkspaceDeactivated`, `clearAuthInvalid`

- `evaluateAccountHealth(acc, now)` → checks rate-limited, model-unsupported, workspace-deactivated, disabled, auth-invalid states; assigns priority score

---

## 3. What Needs to Change in `index.ts` to Start a Router

### Current Plugin Lifecycle

The plugin initializes synchronously and exports hooks. It does NOT start any background server.

### Required Changes

1. **Import Hono and `@hono/node-server`**:
   ```typescript
   import { Hono } from 'hono'
   import { serve } from '@hono/node-server'
   ```

2. **Create a new `router.ts` module** (see section 5) that:
   - Creates a Hono app
   - Registers POST `/v1/chat/completions` handler
   - Registers POST `/v1/responses` handler
   - Handles SSE streaming (proxies `text/event-stream` from Codex directly)
   - Uses `getNextAccount()` for rotation
   - Uses `updateAccount()` to track rate limits
   - Uses `syncAuthFromOpenCode()` to sync auth before each request

3. **In `index.ts`**, after the plugin hooks are defined, start the server:
   ```typescript
   // Inside the MultiAuthPlugin async function, near the end:
   const routerPort = Number(process.env.OPENCODE_MULTI_AUTH_ROUTER_PORT || '18080')
   const routerHost = process.env.OPENCODE_MULTI_AUTH_ROUTER_HOST || '127.0.0.1'
   
   startRouter({ port: routerPort, host: routerHost })
     .then(() => console.log(`[router] listening on ${routerHost}:${routerPort}`))
     .catch(err => console.error('[router] failed to start:', err))
   ```

4. **Web dashboard continues to work** — `web.ts` already manages its own HTTP server on port 3434. The router would use a different port (default 18080), so no conflict.

5. **The router should use the same account store and rotation** — it imports and calls `getNextAccount`, `updateAccount`, etc. directly.

---

## 4. Dependencies Needed

### Install

```bash
npm install hono
npm install --save-dev @types/node
```

### Hono vs Express

- **Hono**: Lightweight (~14KB), designed for edge runtimes, supports SSE natively, has TypeScript types
- **@hono/node-server**: Official Node.js adapter for Hono using Node's `http` module

### Why Hono over Express

1. Tree-shakeable — only bundle what's used
2. No `body-parser` or routing middleware needed
3. Native SSE support via `c.body()` with ReadableStream
4. `c.req.parseBody()` handles FormData cleanly (needed for `multipart/form-data` if streaming)
5. Middleware stack is explicit — easier to reason about request lifecycle

### Compatibility

The project uses `"module": "ES2022"` with `moduleResolution: "bundler"`. Hono v4 is ESM-first and works with this setup.

---

## 5. File Structure for the New Router Module

```
src/
  router.ts          # NEW: Hono app, route handlers, request transformation
  index.ts           # MODIFIED: start router after plugin initialization
  store.ts           # existing
  rotation.ts        # existing
  auth.ts            # existing (ensureValidToken)
  settings.ts        # existing (getRuntimeSettings, getSettings)
  errors.ts          # existing (Errors enum)
  types.ts           # existing (AccountCredentials, PluginConfig, etc.)
  rate-limits.ts     # existing (extractRateLimitUpdate, mergeRateLimits, etc.)
```

### `router.ts` Skeleton

```typescript
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { syncAuthFromOpenCode } from './auth-sync.js'
import { getNextAccount, markAuthInvalid, markRateLimited, markModelUnsupported, markWorkspaceDeactivated } from './rotation.js'
import { updateAccount, loadStore } from './store.js'
import { getRuntimeSettings } from './settings.js'
import { DEFAULT_CONFIG, type PluginConfig } from './types.js'
import { Errors } from './errors.js'
import {
  extractRateLimitUpdate,
  getBlockingRateLimitResetAt,
  mergeRateLimits
} from './rate-limits.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const URL_PATHS = { RESPONSES: '/responses', CODEX_RESPONSES: '/codex/responses' }

// Decode JWT, extract accountId, normalize model — all lifted from index.ts customFetch

function decodeJWT(token: string): Record<string, any> | null
function extractRequestUrl(input: Request | string | URL): string
function extractPathAndSearch(url: string): string
function toCodexBackendUrl(originalUrl: string): string
function normalizeModel(model: string | undefined): string

// Main router setup
export function startRouter(options: { port: number; host: string }): Promise<void>

// POST /v1/chat/completions — OpenAI format
// POST /v1/responses — OpenAI format  
// GET /models — return model list (from models.ts getDefaultModels)
// GET /health — health check
```

### Key Implementation Details for the Router

1. **Request transformation** (mirrors `index.ts` lines 606–772):
   - Parse body JSON, extract `model`, `stream`, `input`, etc.
   - Normalize model name (same logic as `normalizeModel`)
   - Call `getNextAccount({ model: normalizedModel })` for account selection
   - Extract `accountId` from JWT via `decodeJWT(token)[JWT_CLAIM_PATH].chatgpt_account_id`
   - Build Codex URL via `toCodexBackendUrl`
   - Filter `input` items (remove `item_reference` type, strip `id` from items)
   - Handle reasoning effort from model suffix
   - Handle fast mode (`-fast` suffix + `service_tier=priority`)

2. **Response handling** (mirrors `index.ts` lines 775–908):
   - Stream SSE directly from Codex to client (most important for chat.completions)
   - For non-streaming: convert SSE to JSON via `parseSseStream`
   - Extract rate limit headers and update account via `updateAccount`
   - Handle 401/403 → `markAuthInvalid`, 429 → `markRateLimited`, 402 → `markWorkspaceDeactivated`, 400 → `markModelUnsupported`
   - Retry logic with same `maxAttempts` loop

3. **SSE Streaming** (critical for chat/completions):
   - Set ` headers.set('accept', 'text/event-stream')` on request to Codex
   - Return response body directly as `ReadableStream` or use Hono's streaming helpers
   - No transformation needed on data chunks — pass through

4. **CORS**: The router only needs to listen on localhost. No CORS headers needed if clients connect from same origin.

5. **Auth sync**: Call `syncAuthFromOpenCode(getAuth)` at the start of each request to pick up any new accounts added via OpenCode.

---

## 6. OpenAI API Endpoints to Proxy

| Endpoint | Codex Mapping | Notes |
|---|---|---|
| `POST /v1/chat/completions` | → `/codex/chat/completions` | Streaming SSE |
| `POST /v1/responses` | → `/codex/responses` | SSE or JSON |
| `GET /v1/models` | not needed | Return static model list from `getDefaultModels()` |
| `GET /health` | — | `200 OK` for load balancer checks |

---

## 7. Integration Points

### From `index.ts` (copy these functions verbatim):
- `decodeJWT` (line 54)
- `extractRequestUrl` (line 66)
- `extractPathAndSearch` (line 76)
- `toCodexBackendUrl` (line 94)
- `normalizeModel` (line 121)
- `filterInput` (line 108)
- `isSparkModel` (line 155)
- `supportsFastMode` (line 159)
- `resolveRateLimitedUntil` (line 193)
- `parseSseStream` (line 211)
- `extractErrorMessage` (line 171)
- `ensureContentType` (line 163)
- Error handling (401, 403, 429, 402, 400 branches from `customFetch`)

### From `rate-limits.ts`:
- `extractRateLimitUpdate`
- `mergeRateLimits`
- `getBlockingRateLimitResetAt`

### From `errors.ts`:
- `Errors.maxRetriesExceeded`
- `Errors.noEligibleAccounts`

---

## 8. Configuration via Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_MULTI_AUTH_ROUTER_PORT` | `18080` | HTTP server port |
| `OPENCODE_MULTI_AUTH_ROUTER_HOST` | `127.0.0.1` | HTTP server bind address |
| `OPENCODE_MULTI_AUTH_ROTATION_STRATEGY` | `round-robin` | Same as existing |
| `OPENCODE_MULTI_AUTH_TRUNCATION` | — | Same as existing |
| `OPENCODE_MULTI_AUTH_DEBUG` | `0` | Same as existing |

---

## 9. Verification Checklist

- [ ] Router starts successfully on configured port
- [ ] `POST /v1/chat/completions` streams SSE from Codex
- [ ] `POST /v1/responses` returns JSON or streams SSE
- [ ] Account rotation works (test with 2+ accounts)
- [ ] Rate limit tracking updates account in store
- [ ] Auth invalidation marks account correctly
- [ ] Model unsupported marks account correctly
- [ ] Force mode is respected by router
- [ ] Weighted round-robin weights are respected by router
- [ ] Web dashboard continues to work on port 3434
- [ ] Graceful shutdown on SIGTERM
- [ ] No console errors during normal operation