# Tasks: Migrate Logs to Notifications

## Phase 1: Infrastructure / Foundation
- [ ] 1.1 Update `src/logger.ts` to implement `Logger` interface with `log(msg)` and `error(msg)` methods targeting `/tmp/openai-router.log`.
- [ ] 1.2 Ensure `logger.debug` no-ops unless `OPENCODE_MULTI_AUTH_DEBUG === '1'`.
- [ ] 1.3 Ensure backward-compatible named exports `logInfo/logWarn/logError/getLogPath/readLogTail` remain in `src/logger.ts`.

## Phase 2: Core Implementation
- [ ] 2.1 Update `src/index.ts` to implement `notifyRuntimeEvent(kind, detail)` wrapper for `notifyRich`.
- [ ] 2.2 Update `src/index.ts` to replace all `console.log` and `console.error` with `logger.log/error`.
- [ ] 2.3 Update `src/index.ts` startup logic to replace startup logs with `logger.log` and call `notifyRuntimeEvent` for "Primary Router Takeover" and "Initialization Complete".
- [ ] 2.4 Update `src/router.ts` to replace all `console.log` and `console.error` with `logger.log/error`.

## Phase 3: Testing / Verification
- [ ] 3.1 Verify `opencode` startup is silent in the terminal.
- [ ] 3.2 Verify logs are correctly written to `/tmp/openai-router.log`.
- [ ] 3.3 Verify startup notifications appear as expected.
- [ ] 3.4 Verify fatal startup errors still surface to stderr.

## Phase 4: Build / Finalization
- [ ] 4.1 Run `npm run build` to ensure no type issues.
