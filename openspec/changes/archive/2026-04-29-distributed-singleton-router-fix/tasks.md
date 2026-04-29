# Tasks: Distributed Singleton Router Fix

## Phase 1: Foundation / Preparation

- [ ] 1.1 Define `RouterStartupResult` type in `src/index.ts` (if required for helper).
- [ ] 1.2 Extract current initialization logic from `MultiAuthPlugin` into a new `initializePlugin` async function.

## Phase 2: Core Implementation

- [ ] 2.1 Refactor `MultiAuthPlugin` in `src/index.ts` to call `initializePlugin` without awaiting it (fire-and-forget).
- [ ] 2.2 Update `tryStartRouter` in `src/index.ts` to implement `EADDRINUSE` handling logic.
- [ ] 2.3 Implement heartbeat freshness inspection within `tryStartRouter`.
- [ ] 2.4 Implement stale heartbeat/lock cleanup and one-time retry logic in `tryStartRouter` on `EADDRINUSE`.

## Phase 3: Observability

- [ ] 3.1 Refactor all startup-related logs in `src/index.ts` to use the `[openai-router:startup]` prefix.

## Phase 4: Verification

- [ ] 4.1 Run `npm run build` in the root directory and verify it passes.
