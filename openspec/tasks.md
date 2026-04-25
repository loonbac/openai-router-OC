# Tasks: Embedded HTTP Proxy

- [ ] **T1**: Add `hono` + `@hono/node-server` to `package.json`, npm install
  - *Acceptance Criteria*: Dependencies are listed in `package.json` and successfully installed.
- [ ] **T2**: Create `src/heartbeat.ts` (heartbeat coordination)
  - *Acceptance Criteria*: Functions for reading/writing heartbeat, locking, and tracking connections are implemented.
- [ ] **T3**: Create `src/router.ts` (Hono server with proxy logic)
  - *Acceptance Criteria*: Hono server handles `/health` and `/v1/chat/completions`, integrating with `rotation.js` and `store.js`, and implements heartbeat logic.
- [ ] **T4**: Modify `src/index.ts` (start router on plugin init)
  - *Acceptance Criteria*: Plugin starts the Hono router as a detached process and monitors it via heartbeat.
- [ ] **T5**: Build (`tsc`), verify no errors
  - *Acceptance Criteria*: Project compiles successfully without TypeScript errors.
- [ ] **T6**: Test with `curl` (health + chat completions)
  - *Acceptance Criteria*: Both `/health` and `/v1/chat/completions` endpoints respond correctly to `curl` requests.
- [ ] **T7**: Update `openspec/` and `README`
  - *Acceptance Criteria*: Relevant specs and `README` are updated to reflect the new architecture.
