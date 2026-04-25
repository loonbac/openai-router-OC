# Embedded HTTP Proxy Router Specification

## Purpose

Add an embedded Hono HTTP server that proxies OpenAI-format requests to Codex API using existing account rotation logic. The router receives requests from OpenCode (which bypasses the auth loader fetch), transforms them, and streams responses back in OpenAI format.

---

## ADDED Requirements

### Requirement: Embedded HTTP Server Lifecycle

The system SHALL start a Hono HTTP server when the plugin loads, and SHALL shut down the server when the plugin terminates.

The router server MUST bind to `127.0.0.1` only (not exposed externally). The default port MUST be `18080` and MUST be configurable via `OPENCODE_MULTI_AUTH_ROUTER_PORT` environment variable.

#### Scenario: Router starts on plugin initialization

- GIVEN the plugin is loaded
- WHEN the plugin initializes
- THEN the HTTP server SHALL start on `127.0.0.1:18080` by default
- AND the server SHALL be ready to accept connections

#### Scenario: Router binds to configured port

- GIVEN the environment variable `OPENCODE_MULTI_AUTH_ROUTER_PORT` is set to `19090`
- WHEN the plugin initializes
- THEN the HTTP server SHALL bind to `127.0.0.1:19090`

#### Scenario: Router health endpoint responds

- GIVEN the router server is running
- WHEN a client sends `GET /health`
- THEN the server SHALL return `200 OK` with JSON `{ "status": "ok", "port": <listeningPort>, "accounts": <accountCount> }`

#### Scenario: Router terminates with plugin

- GIVEN the router server is running
- WHEN the plugin receives SIGTERM
- THEN the server SHALL gracefully shut down within 5 seconds
- AND SHALL stop accepting new connections

---

### Requirement: OpenAI Chat Completions Proxy

The system SHALL accept `POST /v1/chat/completions` requests in OpenAI format and proxy them to `https://chatgpt.com/backend-api/codex/responses`.

The router MUST use `getNextAccount()` from `rotation.ts` to select an account for each request. The router MUST transform the request to Codex format before forwarding.

#### Scenario: Proxy chat completions request

- GIVEN a client sends `POST /v1/chat/completions` with OpenAI body `{ "model": "gpt-4", "messages": [{"role": "user", "content": "hello"}], "stream": true }`
- WHEN the router receives the request
- THEN the router SHALL call `getNextAccount()` to select an account
- AND SHALL forward the transformed request to `https://chatgpt.com/backend-api/codex/responses`

#### Scenario: Transform request to Codex format

- GIVEN a chat completions request with messages
- WHEN the router transforms the request
- THEN `messages` SHALL become `input` with the same structure
- AND if a `system` message exists, it SHALL become `instructions`
- AND the router SHALL add `stream: true` and `store: false`

#### Scenario: Forward required headers to Codex

- GIVEN the router proxies a request
- THEN the forwarded request SHALL include header `Authorization: Bearer <accountToken>`
- AND SHALL include header `OpenAI-Beta: responses=experimental`
- AND SHALL include header `Accept: text/event-stream`

---

### Requirement: SSE Response Transformation

The system SHALL parse SSE streams from the Codex API and SHALL transform them into OpenAI chat completions SSE format before returning to the client.

#### Scenario: Stream delta content to client

- GIVEN Codex returns an SSE event with `response.output_text.delta`
- WHEN the router receives the SSE event
- THEN the router SHALL transform it to OpenAI format: `choices[0].delta.content`
- AND SHALL stream it to the client in real-time

#### Scenario: Stream completion to client

- GIVEN Codex returns an SSE event with `response.completed`
- WHEN the router receives the SSE event
- THEN the router SHALL transform it to `choices[0].finish_reason: "stop"`
- AND SHALL append a final `[DONE]` marker to the stream

---

### Requirement: Account Rotation on Error

The system SHALL retry failed requests with the next available account when specific error codes are received from Codex.

On HTTP status codes `401`, `403`, `429`, or `5xx`, the router MUST call the appropriate mark function (`markAuthInvalid`, `markRateLimited`) and MUST retry with a different account. The router MUST NOT retry more than 3 attempts total.

#### Scenario: Retry on 401 Unauthorized

- GIVEN a request to Codex returns HTTP 401
- WHEN the router receives the response
- THEN the router SHALL call `markAuthInvalid(currentAlias)`
- AND SHALL retry the request with the next account from `getNextAccount()`
- AND SHALL attempt up to 3 retries total

#### Scenario: Retry on 429 Rate Limited

- GIVEN a request to Codex returns HTTP 429
- WHEN the router receives the response
- THEN the router SHALL call `markRateLimited(currentAlias, <retryAfter>)`
- AND SHALL retry the request with the next account from `getNextAccount()`
- AND SHALL attempt up to 3 retries total

#### Scenario: Fail after max retries

- GIVEN 3 consecutive failed attempts on the same request
- WHEN the third attempt also fails with a retryable error
- THEN the router SHALL return HTTP 502 to the client
- AND SHALL NOT attempt further retries

---

### Requirement: Multi-Instance Heartbeat

The system SHALL use a heartbeat file at `/tmp/openai-router-heartbeat.json` to coordinate multiple plugin instances.

The router MUST write a heartbeat entry every 2 seconds containing `{ "pid": <processId>, "port": <listeningPort>, "timestamp": <unixTimestampMs> }`.

#### Scenario: Passive client when server exists

- GIVEN another instance is already running with a valid heartbeat
- WHEN this instance initializes
- THEN this instance SHALL NOT start a new server
- AND SHALL become a passive client (router functionality disabled)

#### Scenario: Acquire lock and start server

- GIVEN no other instance has a valid heartbeat
- WHEN this instance initializes
- THEN this instance SHALL acquire the lock
- AND SHALL start the router server on the configured port

#### Scenario: Server self-shuts down after idle

- GIVEN the router server is running
- WHEN no requests are received for 30 seconds
- THEN the server SHALL shut down gracefully
- AND SHALL remove the heartbeat file

---

### Requirement: Web Dashboard Preservation

The system SHALL NOT modify the existing web dashboard functionality. The dashboard on port 3434 SHALL continue to operate independently for account management.

#### Scenario: Dashboard remains on port 3434

- GIVEN the plugin is loaded with the router feature
- WHEN the dashboard server is started
- THEN it SHALL remain accessible on port 3434
- AND the router SHALL operate on a different port

#### Scenario: Router does not conflict with dashboard

- GIVEN the dashboard is running on port 3434
- AND the router is running on port 18080
- THEN requests to port 3434 SHALL be handled by the dashboard only
- AND requests to port 18080 SHALL be handled by the router only

---

## Acceptance Criteria

| ID | Criterion | Testable |
|----|-----------|----------|
| AC-1 | Router starts on port 18080 by default | `curl http://127.0.0.1:18080/health` |
| AC-2 | Health endpoint returns status, port, account count | Response body contains all three fields |
| AC-3 | POST /v1/chat/completions proxies to Codex | Request appears at Codex with correct headers |
| AC-4 | SSE from Codex is transformed to OpenAI format | Client receives OpenAI-format SSE |
| AC-5 | 401/403 triggers account invalidation and retry | `markAuthInvalid` called, next account used |
| AC-6 | 429 triggers rate limit marking and retry | `markRateLimited` called, next account used |
| AC-7 | Max 3 retry attempts | Third failure returns 502 |
| AC-8 | Heartbeat file written every 2s | File exists with current pid/timestamp |
| AC-9 | Passive mode when other instance active | No server started, log message shown |
| AC-10 | Server self-shuts down after 30s idle | Process exits, heartbeat file removed |
| AC-11 | Dashboard unchanged on port 3434 | Dashboard responds normally |
