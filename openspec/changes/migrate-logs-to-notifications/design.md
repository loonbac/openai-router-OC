# Design: Migrate Logs to Notifications

## Technical Approach

Refactor runtime observability so `src/index.ts` and `src/router.ts` stop writing normal lifecycle output to stdout/stderr. `src/logger.ts` becomes the shared sink with a small `logger.info/warn/error/debug` API targeting `/tmp/openai-router.log` by default, while a new notification helper in `src/index.ts` wraps `notifyRich` for startup/runtime events that should still reach users when notifications are enabled.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Log destination | Keep `~/.config/.../codex-soft.log`; add second startup file; move to `/tmp/openai-router.log` | Standardize runtime logging on `/tmp/openai-router.log` with env override support | Matches the requested troubleshooting target, keeps router/plugin/shared-process logs in one place, and avoids TUI noise. |
| Logger API shape | Keep `logInfo/logWarn/logError`; export object only; support both | Add `logger.{debug,info,warn,error}` and keep legacy named exports as thin wrappers | Minimizes churn in existing files like `web.ts` while giving the changed files a simpler, consistent API. |
| Notification boundary | Call `notifyRich` directly everywhere; create helper near logger; create helper in plugin startup scope | Add a plugin-scoped helper in `src/index.ts` that wraps `notifyRich` plus throttling/guard rules | `notifyRich` depends on runtime env and session metadata already owned by the plugin, so keeping the wrapper local avoids leaking notification concerns into `logger.ts`. |
| stderr policy | Keep all `console.error`; silence everything; stderr only for fatal bootstrap failures | Only emit stderr for unrecoverable “cannot start at all” failures | Preserves CLI/TUI cleanliness while still surfacing failures where the plugin/router cannot continue safely. |

## Data Flow

```text
Plugin/router event
  -> logger.info|warn|error(message, context?)
  -> append sanitized line to /tmp/openai-router.log

User-relevant startup/runtime event
  -> notifyRuntimeEvent(kind, detail)
      -> guard by OPENCODE_MULTI_AUTH_NOTIFY + throttle
      -> notifyRich(...)

Fatal bootstrap failure
  -> logger.error(...)
  -> process.stderr.write(...)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/logger.ts` | Modify | Replace ad-hoc helpers with centralized logger object, default log path `/tmp/openai-router.log`, optional debug gating, and backward-compatible named exports. |
| `src/index.ts` | Modify | Import the centralized logger, remove local `errorLog`, replace `console.log/error` in startup/router/web-dashboard paths, and add a helper that wraps `notifyRich` for significant startup/runtime notifications. |
| `src/router.ts` | Modify | Import the centralized logger and replace lifecycle/error console calls so router activity is file-only except fatal startup failures that also write to stderr. |
| `openspec/changes/migrate-logs-to-notifications/design.md` | Create | Documents the implementation plan for this change. |

## Interfaces / Contracts

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

type RuntimeNotifyKind = 'startup-ready' | 'startup-warning' | 'runtime-error'

function notifyRuntimeEvent(kind: RuntimeNotifyKind, detail?: string): void
```

Notes:
- `logger.debug` should no-op unless `OPENCODE_MULTI_AUTH_DEBUG === '1'`.
- Existing `logInfo/logWarn/logError/getLogPath/readLogTail` exports stay available for current callers.
- `notifyRuntimeEvent` maps higher-level startup/runtime states to existing `notifyRich` payloads instead of spreading notification formatting through startup code.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Logger path defaulting, sanitization, and debug gating | Add focused tests for `src/logger.ts` with mocked fs/env behavior. |
| Integration | `tryStartRouter`, `ensureRouterHealthy`, and `ensureWebRunning` log to file paths and do not use console for routine states | Verify extracted branches through spies/mocks around logger and notification helper. |
| Verification | Fatal startup failures still surface to stderr while being logged | Simulate unrecoverable bind/start errors and assert `process.stderr.write` plus logger call. |

## Migration / Rollout

No data migration required. Roll out in place by switching affected runtime paths to the centralized logger. Existing dashboard log viewers continue working through `getLogPath()` and will automatically read the new file location.

## Open Questions

- [ ] Should `src/index.ts` send a startup notification only for degraded states (client fallback, stale-file recovery, fatal failure) or also for successful primary startup?
- [ ] Do we want a structured context serializer in `logger.ts` now, or is plain message logging enough for this change scope?
