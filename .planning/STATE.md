# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.
**Current focus:** v1.2 ACP Cutover -- Phase 19: ACP Runtime Foundation

## Current Position

Phase: 19 of 22 (ACP Runtime Foundation)
Plan: 2 of 2 complete
Status: Phase 19 Complete
Last activity: 2026-02-13 -- Completed 19-02 (ACP session service integration)

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**
- Total plans completed: 2 (v1.2)
- Average duration: 9min
- Total execution time: 18min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19. ACP Runtime Foundation | 2/2 | 18min | 9min |
| 20. Event Translation + Permissions | 0/TBD | -- | -- |
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

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 19-02-PLAN.md (ACP session service integration) -- Phase 19 complete
Resume file: None
