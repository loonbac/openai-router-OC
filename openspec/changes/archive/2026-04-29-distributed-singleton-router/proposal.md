# Proposal: Distributed Singleton Router

## Intent

Make port `47990` a shared singleton router across `loonbac`, `insent`, and `yokonad`, with automatic takeover when the active owner dies but at least one OpenCode session remains alive.

## Scope

### In Scope
- Harden heartbeat and lock coordination for one shared router across users.
- Let `src/index.ts` monitor heartbeat health and restart or adopt the router.
- Relax idle shutdown so active OpenCode sessions do not kill the shared router prematurely.

### Out of Scope
- Changing request proxy semantics, rotation rules, or dashboard behavior.
- Adding systemd/supervisor management outside the plugin heartbeat flow.

## Capabilities

### New Capabilities
- `distributed-singleton-router`: Cross-user singleton router ownership, heartbeat recovery, and health-checked takeover for port `47990`.

### Modified Capabilities
- None.

## Approach

Replace the current single-process heartbeat with a cross-user lease model in `/tmp` using world-writable heartbeat/lock files (`chmod 666`). The router will publish owner PID, port, active session/activity metadata, and freshness timestamps; `index.ts` will poll/watch that lease, confirm health via `/health`, and only start `src/router.ts` when the lease is stale or unhealthy. Idle shutdown will be gated by active session presence so the router stays up while any plugin instance is still alive.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/heartbeat.ts` | Modified | Add robust shared heartbeat/lock protocol, stale detection, and permissive `/tmp` file handling. |
| `src/index.ts` | Modified | Add active heartbeat watcher, health confirmation, and restart/takeover behavior for passive clients. |
| `src/router.ts` | Modified | Enforce singleton startup, publish richer heartbeat state, and reduce aggressive idle shutdown while sessions exist. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Split-brain starts two routers during takeover | Medium | Use atomic lock acquisition, health re-check before bind, and post-bind heartbeat verification. |
| Cross-user `/tmp` permissions break coordination | High | Explicitly `chmod 666` heartbeat/lock files after each create/update and tolerate ownership mismatches. |
| Router never exits after sessions disappear | Medium | Track active session leases separately from request idleness and expire them conservatively. |

## Rollback Plan

Revert the heartbeat/lock/session-watch changes in `src/index.ts`, `src/router.ts`, and `src/heartbeat.ts`, restoring the current local-instance coordination and previous idle shutdown behavior.

## Dependencies

- Existing local `/health` endpoint on the embedded router.
- Reliable filesystem semantics for shared files under `/tmp`.

## Success Criteria

- [ ] Only one healthy router serves `127.0.0.1:47990` even when multiple users open OpenCode concurrently.
- [ ] A passive plugin instance detects stale heartbeat or failed health check and successfully restarts/takes over the router.
- [ ] Heartbeat and lock files remain readable and writable across users via `chmod 666`.
- [ ] The router does not self-shutdown while at least one OpenCode session is still active.
