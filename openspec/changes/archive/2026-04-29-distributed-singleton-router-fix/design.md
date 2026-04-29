# Design: Distributed Singleton Router Fix

## Technical Approach

Update `src/index.ts` startup orchestration so the plugin returns immediately while router election and dashboard boot continue in background. The router path will treat `EADDRINUSE` as a recoverable ownership conflict: if the current heartbeat is healthy, become a client; if it is stale or missing, remove stale coordination files and retry router acquisition once. All startup-phase logs will use a consistent `[openai-router:startup]` prefix for observability.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Non-blocking plugin startup | Keep awaited `ensureWebRunning()` and inline jitter; wrap router/dashboard startup in background async work | Fire-and-forget startup task from plugin body | Satisfies the spec that the plugin contract returns immediately and preserves existing startup behavior without changing downstream request flow. |
| Stale ownership recovery | Treat `EADDRINUSE` as terminal client fallback; always delete files; retry with lock cleanup only | On `EADDRINUSE`, inspect heartbeat freshness, cleanup stale files, then retry once | Prevents false takeovers of healthy owners while fixing dead ownership caused by stale heartbeat or lock state. |
| Build integration point | Auto-build inside plugin runtime; run build during apply verification; document external CI only | Keep build as post-apply verification step (`npm run build`) | Runtime code must not spawn builds. Build belongs to implementation verification and CI, matching proposal/spec intent. |

## Data Flow

```text
Plugin load
  ├─ returns contract immediately
  └─ schedules startup task
       ├─ log watcher/router/dashboard phases
       ├─ router attempt after jitter
       │    ├─ startInlineRouter() succeeds -> primary router
       │    └─ EADDRINUSE
       │         ├─ healthy heartbeat -> configure client mode
       │         └─ stale/missing heartbeat -> delete stale files -> retry once
       └─ ensureWebRunning() in background
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/index.ts` | Modify | Refactor startup orchestration to fire-and-forget, add stale cleanup + one-time retry in `tryStartRouter`, and normalize startup logs with `[openai-router:startup]`. |
| `openspec/changes/distributed-singleton-router-fix/design.md` | Create | Documents implementation approach for the change. |

## Interfaces / Contracts

No public API changes. Internal behavior in `src/index.ts` will likely gain a small startup helper, for example:

```ts
type RouterStartupResult = 'primary' | 'client' | 'retry-failed'

async function runStartupTasks(): Promise<void>
function tryStartRouter(): RouterStartupResult
```

The exact helper names can vary, but the contract remains: router startup is best-effort and MUST NOT block plugin return.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `EADDRINUSE` decision branch for healthy vs stale heartbeat | Add focused tests around extracted startup helper(s) or mock heartbeat/fs behavior if test coverage exists for `src/index.ts`. |
| Integration | Plugin returns before dashboard/router readiness | Verify plugin factory resolves without awaiting `ensureWebRunning()` and still schedules startup side effects. |
| Verification | Build integrity after apply | Run `npm run build` once implementation is complete; this is the required post-apply gate. |

## Migration / Rollout

No migration required. Rollout is an in-place behavior change in plugin startup logic.

## Open Questions

- [ ] Should stale cleanup remove only the heartbeat file or both heartbeat and lock files before retry? `src/index.ts` imports `releaseLock`, so the implementation should confirm the safest cleanup set.
- [ ] Does the project already have tests around plugin startup side effects, or will build-only verification be the practical first step for this change?
