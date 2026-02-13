# Requirements: Factory Factory

**Defined:** 2026-02-13
**Core Value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## v1.2 Requirements

Requirements for ACP-only cutover. Each maps to roadmap phases.

### ACP Runtime

- [ ] **RUNTIME-01**: ACP subprocess spawned per FF session using `@zed-industries/claude-code-acp` or `@zed-industries/codex-acp` binaries with stdio pipes
- [ ] **RUNTIME-02**: ClientSideConnection wired from subprocess stdio via `ndJsonStream` from `@agentclientprotocol/sdk`
- [ ] **RUNTIME-03**: Initialize handshake exchanges protocol version, client capabilities, and agent capabilities
- [ ] **RUNTIME-04**: `session/new` creates ACP session with workspace cwd, returns sessionId stored as providerSessionId
- [ ] **RUNTIME-05**: `session/prompt` sends user messages and receives streaming response via `session/update` notifications
- [ ] **RUNTIME-06**: `session/cancel` halts ongoing prompt turn, agent responds with cancelled stop reason
- [ ] **RUNTIME-07**: `session/load` resumes a previous session when agent advertises `loadSession` capability
- [ ] **RUNTIME-08**: Unified AcpRuntimeManager replaces both ClaudeRuntimeManager and CodexAppServerManager
- [ ] **RUNTIME-09**: Process cleanup on session stop (SIGTERM then SIGKILL after grace period) with orphan prevention via non-detached spawn

### Event Translation

- [ ] **EVENT-01**: ACP `session/update` notification variants mapped to FF WebSocket delta events (agent_message_chunk, tool_call, tool_call_update, agent_thought_chunk, plan, config_options_update, current_mode_update, available_commands_update, user_message_chunk)
- [ ] **EVENT-02**: Tool call status lifecycle rendered in chat UI (pending, in_progress, completed/failed) with title, kind, and content
- [ ] **EVENT-03**: Agent thought/reasoning content rendered in collapsible sections separate from message content
- [ ] **EVENT-04**: Plan updates rendered as structured task view with status indicators
- [ ] **EVENT-05**: Slash commands from `available_commands_update` forwarded to frontend
- [ ] **EVENT-06**: ACP events logged to session file logger for debugging
- [ ] **EVENT-07**: Tool call file locations tracked for click-to-open navigation

### Permissions

- [ ] **PERM-01**: `Client.requestPermission()` callback implemented, receiving tool call details and options array with optionId, name, and kind (allow_once, allow_always, reject_once, reject_always)
- [ ] **PERM-02**: Frontend permission UI renders ACP permission options as distinct choices instead of binary allow/deny
- [ ] **PERM-03**: Permission responses carry selected optionId back to agent via `RequestPermissionResponse`

### Configuration

- [ ] **CONFIG-01**: Agent-provided `configOptions` array parsed after `session/new` and `config_options_update` notifications, grouped by category (mode, model, thought_level, custom)
- [ ] **CONFIG-02**: `session/set_config_option` sends user-selected config values to agent, response updates authoritative config state
- [ ] **CONFIG-03**: Frontend config option UI renders selectors grouped by category, driven entirely by agent-provided configOptions
- [ ] **CONFIG-04**: Agent-pushed `config_options_update` notifications reactively update frontend UI without user action
- [ ] **CONFIG-05**: Capability-gated features conditionally shown in UI based on agent capabilities from initialize response

### Cleanup

- [ ] **CLEAN-01**: Claude protocol stack removed (claude/protocol*, process, client, permission-coordinator, permissions, monitoring, registry, session)
- [ ] **CLEAN-02**: Codex protocol stack removed (codex-app-server-manager, codex-session-registry, codex-event-translator, codex-delta-mapper, schema snapshots, interactive method sets)
- [ ] **CLEAN-03**: Obsolete env/config knobs tied to legacy protocols removed
- [ ] **CLEAN-04**: Superseded tests removed and ACP-focused integration tests added (session start/prompt/cancel/stop, permission roundtrip, config option updates, session load capability handling)
- [ ] **CLEAN-05**: Admin/health process reporting updated for ACP-per-session process model
- [ ] **CLEAN-06**: Contributor docs updated to reflect ACP-only architecture

## Future Requirements

### Session Management

- **SESSION-01**: `unstable_listSessions` for session picker UI (deferred until ACP stabilizes)
- **SESSION-02**: `unstable_resumeSession` for warm session resume (deferred until ACP stabilizes)
- **SESSION-03**: `unstable_forkSession` for branching conversations (deferred until ACP stabilizes)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Backward compatibility with old WebSocket message contracts | Pre-release breaking change per issue #996 |
| Legacy provider wire implementations behind flags | Doubles maintenance surface and test matrix |
| Custom `set_thinking_budget` control | Replaced by ACP configOptions with thought_level category |
| Custom `rewind_files` support | Claude-specific control not part of ACP |
| MCP server configuration UI | Passthrough only, agents handle MCP internally |
| Remote/HTTP agent transport | FF runs agents as local subprocesses, stdio only |
| Terminal management via ACP | FF has its own terminal domain, agents manage terminals internally |
| File system operations via ACP | Agents handle files internally via built-in MCP servers |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RUNTIME-01 | - | Pending |
| RUNTIME-02 | - | Pending |
| RUNTIME-03 | - | Pending |
| RUNTIME-04 | - | Pending |
| RUNTIME-05 | - | Pending |
| RUNTIME-06 | - | Pending |
| RUNTIME-07 | - | Pending |
| RUNTIME-08 | - | Pending |
| RUNTIME-09 | - | Pending |
| EVENT-01 | - | Pending |
| EVENT-02 | - | Pending |
| EVENT-03 | - | Pending |
| EVENT-04 | - | Pending |
| EVENT-05 | - | Pending |
| EVENT-06 | - | Pending |
| EVENT-07 | - | Pending |
| PERM-01 | - | Pending |
| PERM-02 | - | Pending |
| PERM-03 | - | Pending |
| CONFIG-01 | - | Pending |
| CONFIG-02 | - | Pending |
| CONFIG-03 | - | Pending |
| CONFIG-04 | - | Pending |
| CONFIG-05 | - | Pending |
| CLEAN-01 | - | Pending |
| CLEAN-02 | - | Pending |
| CLEAN-03 | - | Pending |
| CLEAN-04 | - | Pending |
| CLEAN-05 | - | Pending |
| CLEAN-06 | - | Pending |

**Coverage:**
- v1.2 requirements: 30 total
- Mapped to phases: 0 (pending roadmap creation)
- Unmapped: 30

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after initial definition*
