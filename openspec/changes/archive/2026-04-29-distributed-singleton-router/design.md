# Design: Distributed Singleton Router

## Technical Approach

Use `/tmp` heartbeat and lock files as a shared lease between plugin instances and the standalone router. `src/index.ts` becomes the watcher/orchestrator inside each plugin process: it checks heartbeat freshness plus `/health`, waits a jittered lease window, and promotes itself by starting the router when the current host is stale. `src/heartbeat.ts` centralizes cross-user file IO, permissive `chmod 0o666`, stale detection, and warning-only handling for permission failures.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Coordination storage | per-user files; `/tmp` shared files; OS daemon | `/tmp` shared heartbeat + lock files | Matches current architecture, needs no external supervisor, and supports cross-user takeover if files are world-writable. |
| Leader election trigger | port bind only; heartbeat only; heartbeat + health probe | Heartbeat freshness first, then `/health`, then lock acquisition | Avoids false takeover when a host is alive but delayed, and reduces split-brain by rechecking before bind. |
| Restart contention control | immediate retry; fixed backoff; random jitter | Per-plugin watcher interval with random jitter | Spreads takeover attempts so many OpenCode sessions do NOT restart at once. |
| Permission failure handling | fail hard; silently ignore; degrade with warnings | Graceful degrade with stale detection + warnings | Cross-user `/tmp` ownership can drift; silent failure hides real outages, but hard failure would break all passive clients. |

## Data Flow

```text
Plugin instance
  ├─ watcher tick
  │   ├─ read heartbeat file
  │   ├─ if fresh -> probe /health
  │   └─ if stale/unhealthy -> wait jitter -> acquire lock
  ├─ if lock acquired -> start router host
  └─ else -> remain client and retry next tick

Router host
  ├─ serve 127.0.0.1:47990
  ├─ write heartbeat every 2s
  └─ release lock on shutdown
```

Takeover sequence:

```text
stale heartbeat OR failed /health
  -> watcher marks host suspect
  -> random jitter delay
  -> reread heartbeat
  -> tryAcquireLock()
  -> start router.ts / inline router
  -> startHeartbeat() publishes new owner pid+port
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/heartbeat.ts` | Modify | Add safe file writer/reader helpers, post-write `chmodSync(path, 0o666)`, stale lock inspection, richer result types for permission/staleness, and warning logging for `EACCES`/parse failures. |
| `src/index.ts` | Modify | Add watcher interval for heartbeat health, jittered promotion attempts, router client/host state transitions, and restart guard logic so one plugin can adopt the router after host loss. |
| `src/router.ts` | Modify | Use hardened heartbeat APIs, acquire/release shared lock consistently, and gate idle shutdown on distributed lease/session presence rather than local connection idleness alone. |

## Interfaces / Contracts

```ts
interface HeartbeatData {
  pid: number
  port: number
  timestamp: number
  connections: number
  ownerSession?: string
}

interface CoordinationReadResult<T> {
  data: T | null
  stale: boolean
  writable: boolean
  errorCode?: string
  warning?: string
}

interface WatcherDecision {
  shouldPromote: boolean
  reason: 'missing-heartbeat' | 'stale-heartbeat' | 'healthcheck-failed' | 'lock-busy'
  jitterMs?: number
}
```

Notes:
- `startHeartbeat()` should write, then immediately `chmodSync(file, 0o666)` after create/overwrite.
- `readHeartbeat()` should distinguish `missing`, `invalid`, and `permission-denied` so watcher logic can warn and still evaluate probable staleness.
- `tryAcquireLock()` should treat unreadable but stale lock files as recoverable only after age check/read attempt; otherwise it returns busy and logs a warning.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Heartbeat read/write chmod flow, stale detection, `EACCES` fallback paths, lock contention rules | Jest tests with mocked `node:fs` and deterministic timestamps/random jitter. |
| Integration | Plugin watcher promotes after stale heartbeat and does not promote while healthy host responds | Spawn watcher/router processes against temp files and stub `/health` responses. |
| E2E | Multi-user-style takeover behavior and jitter preventing thundering herd | Existing integration/stress suite with multiple plugin instances racing for the same port/files. |

## Migration / Rollout

No migration required. Roll out as a code-only change; existing `/tmp/openai-router-*.json` files are reused and normalized on next write.

## Open Questions

- [ ] Should session lease metadata live inside the heartbeat file or a separate `/tmp` lease file if router idle shutdown needs per-plugin liveness rather than owner-only liveness?
- [ ] Should watcher logging be debug-only for repeated permission warnings to avoid noisy OpenCode output during long-running sessions?
