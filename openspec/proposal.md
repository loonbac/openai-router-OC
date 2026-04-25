# Change Proposal: Embedded HTTP Proxy Router

## Problem
OpenCode ignores the auth loader's `fetch` option. The plugin's custom fetch that remaps URLs and rotates accounts never gets called. Requests go to the wrong endpoint and fail with "Not Found".

## Solution
Add an embedded Hono HTTP server that:
- Starts alongside the existing plugin functionality
- Accepts OpenAI-compatible requests (`POST /v1/chat/completions`)
- Uses the EXISTING account store (`store.ts`) and rotation (`getNextAccount` from `rotation.ts`)
- Proxies to Codex API at `https://chatgpt.com/backend-api/codex/responses`
- Streams SSE responses back in OpenAI format
- Multi-instance resilient (heartbeat + auto-takeover)

## Scope
- New file: `src/router.ts` (Hono server with proxy logic)
- Modified: `src/index.ts` (start router on plugin init)
- New deps: `hono`, `@hono/node-server` in `package.json`
- Unchanged: `web.ts`, `cli.ts`, `store.ts`, `rotation.ts`, `models.ts` (all existing features preserved)

## Non-goals
- Rewriting existing plugin functionality
- Changing the web dashboard
- Changing the CLI
- Changing account storage format