# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.
**Current focus:** v1.2 ACP Cutover -- Phase 21: Config Options + Unified Runtime

## Current Position

Phase: 21 of 22 (Config Options + Unified Runtime)
Plan: 2 of 3 (executing)
Status: Phase 21 executing -- plan 02 complete
Last activity: 2026-02-13 -- Plan 21-02 executed

Progress: [████████░░] 75%

## Performance Metrics

**Velocity:**
- Total plans completed: 7 (v1.2)
- Average duration: 7min
- Total execution time: 48min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19. ACP Runtime Foundation | 2/2 | 18min | 9min |
| 20. Event Translation + Permissions | 3/3 | 26min | 6min |
| 21. Config Options + Unified Runtime | 2/3 | 13min | 6min |
| 22. Cleanup + Polish | 0/TBD | -- | -- |

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

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 21-02-PLAN.md
Resume file: None
