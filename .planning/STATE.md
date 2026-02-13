# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.
**Current focus:** v1.2 ACP Cutover -- Phase 20: Event Translation + Permissions

## Current Position

Phase: 20 of 22 (Event Translation + Permissions)
Plan: 1 of 3 complete
Status: Phase 20 in progress (Plan 01 complete, Plan 02 next)
Last activity: 2026-02-13 -- Completed 20-01 (Event Translator + Permission Bridge)

Progress: [██░░░░░░░░] 25%

## Performance Metrics

**Velocity:**
- Total plans completed: 3 (v1.2)
- Average duration: 8min
- Total execution time: 23min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19. ACP Runtime Foundation | 2/2 | 18min | 9min |
| 20. Event Translation + Permissions | 1/3 | 5min | 5min |
| 21. Config Options + Unified Runtime | 0/TBD | -- | -- |
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

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 20-01-PLAN.md (Event Translator + Permission Bridge)
Resume file: None
