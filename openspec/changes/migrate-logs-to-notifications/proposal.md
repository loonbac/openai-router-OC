# Proposal: Migrate Logs to Notifications

## Intent

Remove plugin startup/runtime `console.log` and `console.error` output that pollutes the OpenCode TUI while preserving user-visible signals and postmortem diagnostics.

## Scope

### In Scope
- Replace terminal logging in `src/index.ts` and `src/router.ts` with silent file logging and selective notifications.
- Reuse `notifyRich` for important user-facing startup/runtime events when notifications are enabled.
- Consolidate debug/error persistence around `src/logger.ts`, including a stable troubleshooting file path.

### Out of Scope
- Rewriting CLI-oriented console output outside plugin/runtime flows.
- Changing router, dashboard, or account-rotation behavior beyond logging side effects.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `embedded-http-proxy-router`: startup observability changes from terminal output to silent logging plus optional rich notifications.

## Approach

Adopt `src/logger.ts` as the shared silent logger for plugin and router lifecycle messages, standardize a debug log target (compatible with `/tmp/openai-router-errors.log` expectations), and route only meaningful user events through `notifyRich`. Routine state transitions, retries, bind conflicts, and child-process output should go to file logging instead of stdout/stderr.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/index.ts` | Modified | Replace startup/runtime console calls, wire notifications only for user-relevant events |
| `src/router.ts` | Modified | Replace router lifecycle/error console calls with silent logger |
| `src/logger.ts` | Modified | Centralize append helpers and stable debug log path for troubleshooting |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Important failures become invisible | Med | Promote only actionable failures to `notifyRich`; keep detailed file logs |
| Notification spam replaces console spam | Med | Restrict notifications to significant events and throttle existing paths |
| Debug path changes break troubleshooting habits | Low | Preserve env override and support the expected `/tmp/openai-router-errors.log` destination |

## Rollback Plan

Revert logging integration in `src/index.ts`, `src/router.ts`, and `src/logger.ts` to restore current console-based observability. No data migrations or protocol changes are involved.

## Dependencies

- Existing notification helpers in `src/index.ts`
- Existing file logger module in `src/logger.ts`

## Success Criteria

- [ ] Plugin startup and router runtime remain silent in the OpenCode terminal/TUI.
- [ ] Important user-facing events still surface via `notifyRich` or equivalent only when notifications are enabled.
- [ ] Troubleshooting details continue to be written to a debug log file without relying on stdout/stderr.
