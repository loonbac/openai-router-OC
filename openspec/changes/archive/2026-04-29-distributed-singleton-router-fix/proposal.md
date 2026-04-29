# Proposal: Distributed Singleton Router Fix

## Intent

Fix plugin startup hangs and guarantee router recovery when shared singleton state becomes stale. The plugin must return promptly during startup while still restoring router ownership if the heartbeat is stale and the port remains occupied.

## Scope

### In Scope
- Make router and dashboard startup non-blocking in `src/index.ts`, including removing the awaited dashboard startup path.
- Add forced stale-state cleanup when router startup hits `EADDRINUSE` but heartbeat state is missing or stale.
- Add clearer startup-phase logging for router election, takeover, cleanup, and dashboard launch readiness.

### Out of Scope
- Changing request proxying, account rotation behavior, or dashboard features.
- Reworking heartbeat file format or moving coordination out of the current local filesystem model.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `embedded-http-proxy-router`: Startup and recovery behavior for the embedded router and dashboard becomes non-blocking and self-healing under stale singleton state.

## Approach

Refactor `src/index.ts` startup flow so jittered router promotion and `ensureWebRunning()` run as fire-and-forget tasks with explicit phase logging instead of blocking plugin initialization. When startup or takeover sees `EADDRINUSE`, re-check heartbeat freshness; if the heartbeat is stale or absent, perform forced cleanup of stale coordination state before retrying router acquisition, otherwise remain a client of the healthy owner.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/index.ts` | Modified | Make startup asynchronous, add stale-state force cleanup path, and improve startup/recovery logging. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Forced cleanup removes state during a slow-but-live startup | Medium | Re-check heartbeat freshness immediately before cleanup and only force cleanup on stale/missing heartbeat plus `EADDRINUSE`. |
| Non-blocking startup hides failures | Medium | Add explicit phase logs for scheduling, success, fallback-to-client, cleanup, and retry results. |

## Rollback Plan

Revert `src/index.ts` to the current awaited startup sequence and remove the stale-state force-cleanup branch plus new logging if non-blocking startup causes regressions.

## Dependencies

- Existing heartbeat helpers used by `src/index.ts` for stale detection.
- Project verification requirement to run `npm run build` after implementation.

## Success Criteria

- [ ] Plugin initialization returns without waiting for dashboard readiness or jittered router election delays.
- [ ] Router startup recovers from stale heartbeat plus `EADDRINUSE` by cleaning stale state and retrying takeover.
- [ ] Startup logs clearly show router scheduling, stale cleanup decisions, takeover outcome, and dashboard startup phases.
- [ ] `npm run build` passes after the implementation change.
