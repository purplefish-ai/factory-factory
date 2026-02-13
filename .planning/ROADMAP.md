# Roadmap: Factory Factory

## Milestones

- ✅ **v1.0 SRP Consolidation** -- Phases 1-10 (shipped 2026-02-10) -- [Archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Project Snapshot Service** -- Phases 11-18 (shipped 2026-02-11) -- [Archive](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 ACP Cutover** -- Phases 19-22 (in progress)

## Phases

<details>
<summary>v1.0 SRP Consolidation (Phases 1-10) -- SHIPPED 2026-02-10</summary>

See [v1.0 Roadmap Archive](milestones/v1.0-ROADMAP.md) for full phase details.

</details>

<details>
<summary>v1.1 Project Snapshot Service (Phases 11-18) -- SHIPPED 2026-02-11</summary>

See [v1.1 Roadmap Archive](milestones/v1.1-ROADMAP.md) for full phase details.

</details>

### v1.2 ACP Cutover

**Milestone Goal:** Replace custom Claude NDJSON and Codex app-server protocols with a single ACP-only runtime using Zed's production adapters, unifying both providers under one subprocess-per-session model with native permission options, config controls, and event streaming.

- [x] **Phase 19: ACP Runtime Foundation** - Subprocess lifecycle, connection wiring, session create/prompt/cancel with streaming (completed 2026-02-13)
- [x] **Phase 20: Event Translation + Permissions** - ACP event mapping to FF UI, permission option selection, tool call rendering (completed 2026-02-13)
- [ ] **Phase 21: Config Options + Unified Runtime** - Agent-driven config controls, capability gating, session load, unified runtime manager
- [ ] **Phase 22: Cleanup + Polish** - Legacy protocol removal, ACP-focused tests, health reporting, contributor docs

## Phase Details

### Phase 19: ACP Runtime Foundation
**Goal**: A single ACP session can start, exchange a prompt, stream a response, cancel mid-turn, and shut down cleanly -- proving the entire subprocess + ClientSideConnection + JSON-RPC pipeline end-to-end
**Depends on**: Nothing (first phase of v1.2)
**Requirements**: RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04, RUNTIME-05, RUNTIME-06, RUNTIME-09, EVENT-06
**Success Criteria** (what must be TRUE):
  1. Starting a session spawns an ACP subprocess, completes the initialize handshake, and creates a provider session -- visible in session logs
  2. Sending a message produces a streaming response that appears in the chat UI as agent message chunks
  3. Cancelling a prompt mid-turn halts the agent and returns a cancelled stop reason within the grace period
  4. Stopping a session terminates the subprocess cleanly (SIGTERM then SIGKILL) with no orphaned processes remaining
  5. All ACP protocol events are written to the session file log for debugging
**Plans:** 2 plans

Plans:
- [x] 19-01-PLAN.md -- ACP runtime module: types, process handle, client handler, runtime manager, unit tests
- [x] 19-02-PLAN.md -- Wire ACP into session service, barrel exports, end-to-end verification

### Phase 20: Event Translation + Permissions
**Goal**: ACP events render correctly in the FF frontend (tool calls, thoughts, plans, slash commands) and permission requests present the full ACP option set (allow_once, allow_always, reject_once, reject_always) end-to-end
**Depends on**: Phase 19
**Requirements**: EVENT-01, EVENT-02, EVENT-03, EVENT-04, EVENT-05, EVENT-07, PERM-01, PERM-02, PERM-03
**Success Criteria** (what must be TRUE):
  1. Tool calls from the agent appear in the chat UI with status lifecycle (pending, in_progress, completed/failed), title, kind, and content -- clicking a file-related tool call opens the file
  2. Agent reasoning/thinking content renders in collapsible sections separate from main message content
  3. Plan updates from the agent render as a structured task view with per-task status indicators
  4. Permission requests present distinct option buttons (allow once, allow always, deny once, deny always) and the selected option flows back to the agent as an optionId
  5. Slash commands from the agent appear in the frontend command palette
**Plans:** 3 plans

Plans:
- [x] 20-01-PLAN.md -- AcpEventTranslator and AcpPermissionBridge: isolated backend classes with unit tests
- [x] 20-02-PLAN.md -- Wire translator and bridge into session service, extend WebSocket types, permission handler routing
- [x] 20-03-PLAN.md -- Frontend: ACP multi-option permission UI, plan view component, visual verification

### Phase 21: Config Options + Unified Runtime
**Goal**: Model, mode, and reasoning controls are driven entirely by agent-provided configOptions (not hardcoded), session resume works when the agent supports it, and a single AcpRuntimeManager serves both Claude and Codex providers
**Depends on**: Phase 20
**Requirements**: CONFIG-01, CONFIG-02, CONFIG-03, CONFIG-04, CONFIG-05, RUNTIME-07, RUNTIME-08
**Success Criteria** (what must be TRUE):
  1. After session start, config option selectors (model, mode, thought level) appear in the UI grouped by category, populated entirely from agent-reported configOptions
  2. Selecting a config option sends `session/set_config_option` to the agent and the UI updates to reflect the agent's authoritative response
  3. When the agent pushes a `config_options_update` notification, the UI reactively updates without user action
  4. Session resume via `session/load` works when the agent advertises `loadSession` capability, and the UI gracefully falls back to new session when the capability is absent
  5. Both Claude and Codex sessions use the same AcpRuntimeManager -- no provider-specific runtime code remains
**Plans:** 3 plans

Plans:
- [ ] 21-01-PLAN.md -- Backend config options lifecycle: parse, store, translate, set, and session resume
- [ ] 21-02-PLAN.md -- Frontend config options UI: reducer state, WebSocket handling, and config selector components
- [ ] 21-03-PLAN.md -- Unified AcpRuntimeManager: all new sessions use ACP, legacy manager usage removed

### Phase 22: Cleanup + Polish
**Goal**: All legacy protocol code is deleted, ACP-focused integration tests replace superseded tests, and operational tooling reflects the new per-session process model
**Depends on**: Phase 21
**Requirements**: CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04, CLEAN-05, CLEAN-06
**Success Criteria** (what must be TRUE):
  1. The Claude NDJSON protocol stack (claude/protocol*, process, client, permission-coordinator, permissions, monitoring, registry, session) no longer exists in the codebase
  2. The Codex app-server stack (codex-app-server-manager, codex-session-registry, codex-event-translator, codex-delta-mapper, schema snapshots) no longer exists in the codebase
  3. ACP-focused integration tests cover session start/prompt/cancel/stop, permission roundtrip, config option updates, and session load capability handling -- all passing
  4. Admin/health process reporting shows per-session ACP subprocess status instead of legacy singleton process info
  5. Contributor docs (AGENTS.md) reflect ACP-only architecture with no references to removed protocol code
**Plans**: TBD

Plans:
- [ ] 22-01: TBD
- [ ] 22-02: TBD

## Progress

**Execution Order:** Phase 19 -> 20 -> 21 -> 22

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 19. ACP Runtime Foundation | v1.2 | 2/2 | ✓ Complete | 2026-02-13 |
| 20. Event Translation + Permissions | v1.2 | 3/3 | ✓ Complete | 2026-02-13 |
| 21. Config Options + Unified Runtime | v1.2 | 0/3 | Planned | - |
| 22. Cleanup + Polish | v1.2 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-02-10*
*Last updated: 2026-02-13 -- Phase 21 planned (3 plans in 3 waves)*
