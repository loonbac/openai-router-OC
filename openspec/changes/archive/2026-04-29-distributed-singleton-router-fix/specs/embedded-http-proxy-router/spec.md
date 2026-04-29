# Delta for Embedded HTTP Proxy Router

## ADDED Requirements

### Requirement: Plugin Initialization
The plugin MUST return the contract object to OpenCode immediately upon load, without awaiting router or dashboard startup.

#### Scenario: Plugin returns contract immediately
- GIVEN the plugin is loading
- WHEN the plugin starts initialization
- THEN it MUST return the contract object to OpenCode before starting router or dashboard servers

### Requirement: Startup Logging
The plugin MUST log the commencement of each startup phase to ensure observability.

#### Scenario: Log startup phases
- GIVEN the plugin is initializing
- WHEN the watcher starts, the dashboard starts, or a router attempt begins
- THEN the plugin MUST log the commencement of each phase

### Requirement: Build Verification
Every implementation cycle MUST conclude with a successful `npm run build` execution to ensure code integrity.

#### Scenario: Verify build success
- GIVEN an implementation cycle is complete
- WHEN the developer or CI runs `npm run build`
- THEN the command MUST exit with code 0

## MODIFIED Requirements

### Requirement: Distributed Singleton Heartbeat
The system SHALL use a shared heartbeat file at `/tmp/openai-router-heartbeat.json` to coordinate a singleton router instance across multiple user sessions. The files MUST be world-writable (`chmod 666`) to ensure cross-user access.

The router MUST write a heartbeat entry every 2 seconds containing `{ "pid": <processId>, "port": <listeningPort>, "timestamp": <unixTimestampMs>, "owner": <userId> }`.

(Previously: Added EADDRINUSE handling to the heartbeat coordination)

#### Scenario: Passive client when server exists
- GIVEN another instance is already running with a valid, healthy heartbeat
- WHEN this instance initializes
- THEN this instance SHALL NOT start a new server
- AND SHALL become a passive client (router functionality disabled)

#### Scenario: Acquire lock and take over
- GIVEN no other instance has a valid, healthy heartbeat
- WHEN this instance initializes
- THEN this instance SHALL acquire the lock
- AND SHALL start the router server on the configured port

#### Scenario: Server shutdown gated by active sessions
- GIVEN the router server is running
- WHEN no requests are received for a period
- THEN the server SHALL check for active user sessions
- AND SHALL only shut down gracefully if NO OpenCode sessions are active
- AND SHALL remove the heartbeat file upon shutdown

#### Scenario: Handle stale heartbeat on EADDRINUSE
- GIVEN a router attempt fails with `EADDRINUSE`
- AND the heartbeat file indicates a stale process
- WHEN the plugin attempts to start the router
- THEN the plugin SHALL remove the stale heartbeat file
- AND SHALL retry the router start exactly ONCE
