# Design: Embedded HTTP Proxy

## Architecture
The router is a Hono HTTP server embedded in the existing plugin. It runs as a detached process (like the Gemini Router pattern).

## Files to create/modify

### `src/router.ts` (NEW - ~200 lines)
- Hono app with routes: `GET /health`, `POST /v1/chat/completions`
- Imports `getNextAccount` from `./rotation.js`
- Imports `updateAccount`, `markAuthInvalid`, `markRateLimited` from `./rotation.js`
- Imports `loadStore` from `./store.js`
- Has its own `proxyToCodex()` function (fetch to Codex API, parse SSE)
- Has `transformRequest()` and `transformSSEEvent()` functions
- Heartbeat: writes to `/tmp/openai-router-heartbeat.json` every 2s
- Connection tracking for idle shutdown
- Graceful drain on SIGTERM

### `src/heartbeat.ts` (NEW - ~100 lines)
- `readHeartbeat()`, `isHeartbeatStale()`, `tryAcquireLock()`, `releaseLock()`
- `startHeartbeat(port)`, `stopHeartbeat()`
- `connectionStart()`, `connectionEnd()`, `getIdleTimeMs()`

### `src/index.ts` (MODIFIED)
- Import `startRouter` from `./router.js`
- In the Plugin function, after existing setup, call `startRouter()`
- The router starts as detached process, plugin monitors via heartbeat
- On `app.closing`: DO NOT kill router (server is independent)

### `package.json` (MODIFIED)
- Add `"hono"` to dependencies
- Add `"@hono/node-server"` to dependencies

## Data Flow
```
OpenCode → POST localhost:18080/v1/chat/completions
  → router.ts: parse body
  → getNextAccount() → { account, token }
  → transformRequest(body) → Codex format
  → fetch("https://chatgpt.com/backend-api/codex/responses", { headers, body })
  → parse SSE response
  → transformSSEEvent() → OpenAI format
  → stream back to OpenCode
```
