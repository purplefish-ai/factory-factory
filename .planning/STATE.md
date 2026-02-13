# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.
**Current focus:** v1.2 ACP Cutover -- Phase 19: ACP Runtime Foundation

## Current Position

Phase: 19 of 22 (ACP Runtime Foundation)
Plan: 1 of 2 complete
Status: Executing Phase 19
Last activity: 2026-02-13 -- Completed 19-01 (ACP runtime module)

Progress: [██░░░░░░░░] 10%

## Performance Metrics

**Velocity:**
- Total plans completed: 1 (v1.2)
- Average duration: 13min
- Total execution time: 13min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19. ACP Runtime Foundation | 1/2 | 13min | 13min |
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

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 19-01-PLAN.md (ACP runtime module)
Resume file: None
