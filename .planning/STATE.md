# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.
**Current focus:** v1.2 ACP Cutover -- Phase 21 complete, Phase 22: Cleanup + Polish

## Current Position

Phase: 22 of 22 (Cleanup + Polish)
Plan: 1 of 3 (complete)
Status: Plan 22-01 complete -- ready for Plan 22-02
Last activity: 2026-02-13 -- Plan 22-01 executed

Progress: [██████████] 90%

## Performance Metrics

**Velocity:**
- Total plans completed: 9 (v1.2)
- Average duration: 8min
- Total execution time: 74min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19. ACP Runtime Foundation | 2/2 | 18min | 9min |
| 20. Event Translation + Permissions | 3/3 | 26min | 6min |
| 21. Config Options + Unified Runtime | 3/3 | 23min | 8min |
| 22. Cleanup + Polish | 1/3 | 16min | 16min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
14 decisions recorded across v1.0 and v1.1.

Key research findings affecting v1.2:
- Use `@agentclientprotocol/sdk` (not deprecated `@zed-industries/agent-client-protocol`)
- Non-detached spawn for orphan prevention (children receive SIGHUP on parent death)
- Permission model shifts from binary allow/deny to multi-option selection (allow_once/always, reject_once/reject_always)
- Use prompt response (not notifications) as authoritative turn-complete signal to avoid event ordering inversion

Phase 19-01 decisions:
- Defined AcpProvider type inline to respect dependency-cruiser boundaries (not importing SessionProvider)
- Updated dependency-cruiser to allow acp/ module to import runtime/ interfaces
- ACP binary packages added to knip ignoreDependencies (runtime binaries, not JS imports)
- ACP events prefixed with `acp_` to distinguish from legacy event types
- Used actual SDK RequestPermissionOutcome format (plan had incorrect format)

Phase 19-02 decisions:
- ACP sessions detected at runtime via acpRuntimeManager.getClient() inside existing sendSessionMessage/stopSession -- no new API routes needed
- ACP event types mapped to existing delta pipeline types (agent_message, content_block_start, tool_progress)
- useAcp opt-in flag gates ACP session creation -- safe for production deployment
- Fire-and-forget prompt dispatch pattern matching Codex precedent

Phase 20-01 decisions:
- AcpEventTranslator follows CodexEventTranslator stateless class pattern with switch on sessionUpdate discriminant
- tool_call emits both content_block_start (rendering) and tool_progress (status/locations tracking) as two events
- plan events use task_notification with JSON.stringify for structured data (frontend parses acp_plan type)
- AcpPermissionBridge stores resolve callback + original params for re-emit on session restore
- Defensive translation pattern: never throw, log warnings, return empty arrays for malformed data

Phase 20-02 decisions:
- AcpClientHandler forwards raw SessionUpdate for centralized translation (no inline switch)
- Permission bridge created per-session in setupAcpEventHandler, stored in Map on SessionService
- Bridge cleanup in both stopSession ACP path and onExit handler prevents Promise leaks
- ACP permission requests emit both delta event (UI) and setPendingInteractiveRequest (session restore)
- WebSocket types extended with acpOptions and optionId as optional fields (backward-compatible)

Phase 20-03 decisions:
- AcpPermissionPrompt in same file as PermissionPrompt with acpOptions guard routing
- ACP plan updates parsed from task_notification JSON with acp_plan type discriminant
- Tool progress acpLocations rendered as clickable buttons dispatching acp-open-file custom events
- acpPlan and toolProgress surfaced through full hook chain to AgentLiveDock

Phase 20 integration fixes (post-verification):
- Text accumulation via acpStreamState map (reuse order for frontend upsert)
- Thinking deltas as content_block_delta/thinking_delta (not content_block_start)
- tool_result emission on tool_call_update completed/failed (frontend pairing)
- Transcript persistence via upsertClaudeEvent/appendClaudeEvent
- Peek-then-dequeue dispatch pattern (message stays in queue during auto-start)
- Hydrator preserves in-memory transcript for ACP sessions (no JSONL wipe)
- sendSessionMessage fast-path for known adapters

Phase 21-01 decisions:
- Loose configOptions type in WebSocket types (not importing SDK types into shared module)
- Extracted createOrResumeSession helper to keep createClient under Biome cognitive complexity limit
- Config options emit as config_options_update delta (not chat_capabilities) to keep systems parallel
- setSessionModel/setSessionThinkingBudget find matching configOption by category, return silently if no match

Phase 21-02 decisions:
- AcpConfigOption uses union type (AcpConfigOptionValue | AcpConfigOptionGroup) for flat and grouped option arrays
- ACP config selectors fully replace legacy model/reasoning/thinking controls when acpConfigOptions present
- No optimistic state update on setConfigOption -- wait for authoritative config_options_update from server
- Props threaded through container -> chat content -> chat input chain (no context provider)

Phase 21-03 decisions:
- All new sessions route through AcpRuntimeManager regardless of provider -- legacy adapters only for already-running sessions
- Removed createClaudeClient, createCodexClient, loadCodexSessionContext, buildClientOptions, buildClientEventHandlers as dead code
- buildAcpChatBarCapabilities derives model/thinking from configOptions categories
- Legacy runtime managers kept but deprecated with @deprecated JSDoc for Phase 22

Phase 22-01 decisions:
- Kept 12 deprecated stub methods in SessionService for consumer API compatibility during incremental migration
- Changed getClient return type to unknown to avoid claude/ imports, fixed 4 consumer files with type casts
- Made getChatBarCapabilities synchronous with default fallback instead of legacy adapter delegation
- SessionFileReader relocated to data/ directory independent of claude/ directory

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 22-01-PLAN.md
Resume file: None
