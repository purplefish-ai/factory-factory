---
phase: 19-acp-runtime-foundation
plan: 01
subsystem: runtime
tags: [acp, subprocess, ClientSideConnection, ndJsonStream, ProviderRuntimeManager, streaming]

# Dependency graph
requires: []
provides:
  - "AcpRuntimeManager implementing ProviderRuntimeManager with spawn/initialize/newSession/prompt/cancel/stop lifecycle"
  - "AcpProcessHandle class wrapping per-session connection, child process, and state"
  - "AcpClientHandler implementing ACP Client interface with event routing and permission auto-approve"
  - "AcpRuntimeEventHandlers extending RuntimeEventHandlers with onAcpEvent callback"
affects:
  - "19-02 (session service integration)"
  - "20 (event translation + permissions)"
  - "21 (config options + unified runtime)"

# Tech tracking
tech-stack:
  added:
    - "@agentclientprotocol/sdk@0.14.1"
    - "@zed-industries/claude-code-acp@0.16.1"
    - "@zed-industries/codex-acp@0.9.2"
  patterns:
    - "Non-detached subprocess spawn for orphan prevention"
    - "SIGTERM -> 5s grace -> SIGKILL escalation for graceful shutdown"
    - "pLimit(1) per-session creation lock with dedup (matching ClaudeRuntimeManager)"
    - "Prompt response as authoritative turn-complete signal (isPromptInFlight flag)"
    - "ACP event prefixing (acp_agent_message_chunk, acp_tool_call, acp_tool_call_update)"

key-files:
  created:
    - "src/backend/domains/session/acp/types.ts"
    - "src/backend/domains/session/acp/acp-process-handle.ts"
    - "src/backend/domains/session/acp/acp-client-handler.ts"
    - "src/backend/domains/session/acp/acp-runtime-manager.ts"
    - "src/backend/domains/session/acp/index.ts"
    - "src/backend/domains/session/acp/acp-runtime-manager.test.ts"
  modified:
    - "package.json"
    - "pnpm-lock.yaml"
    - "knip.json"
    - ".dependency-cruiser.cjs"

key-decisions:
  - "Defined AcpProvider type inline instead of importing SessionProvider from providers/ to respect dependency-cruiser boundaries"
  - "Used RequestPermissionOutcome with { outcome: 'selected', optionId } format matching actual ACP SDK types (plan suggested different format)"
  - "Resolved ACP binary paths via require.resolve package.json + bin field with PATH fallback"
  - "Added explicit null checks for child.stdout/stdin instead of non-null assertions to satisfy Biome linter"
  - "Updated dependency-cruiser to allow acp/ module to import from runtime/ interfaces"
  - "Added ACP binary packages to knip ignoreDependencies (runtime binaries, not JS imports)"
  - "Added session_info_update and usage_update to deferred event types (discovered in SDK schema, not in plan)"

patterns-established:
  - "ACP submodule pattern: types.ts + process-handle.ts + client-handler.ts + runtime-manager.ts + barrel index.ts"
  - "ACP event forwarding: prefix with acp_ to distinguish from legacy event types"
  - "Permission auto-approve: prefer allow_always/allow_once, fallback to first option"

# Metrics
duration: 13min
completed: 2026-02-13
---

# Phase 19 Plan 01: ACP Runtime Module Summary

**AcpRuntimeManager with subprocess lifecycle, ClientSideConnection wiring, streaming event routing, and permission auto-approve over @agentclientprotocol/sdk**

## Performance

- **Duration:** 13 min
- **Started:** 2026-02-13T17:20:13Z
- **Completed:** 2026-02-13T17:34:12Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Complete `src/backend/domains/session/acp/` submodule with 6 files implementing the ACP runtime
- AcpRuntimeManager implements ProviderRuntimeManager with full lifecycle: spawn (detached:false), initialize handshake, newSession, sendPrompt, cancelPrompt, stopClient (SIGTERM/SIGKILL escalation)
- AcpClientHandler implements ACP SDK Client interface with sessionUpdate event routing (3 forwarded types, 8 deferred types) and requestPermission auto-approve
- 25 unit tests covering spawn, dedup, stop, cancel, prompt, event handling, and permission auto-approve

## Task Commits

Each task was committed atomically:

1. **Task 1: Install ACP packages and create types + process handle** - `5547f49f` (feat)
2. **Task 2: Build AcpClientHandler with event routing and permission auto-approve** - `696959d0` (feat)
3. **Task 3: Build AcpRuntimeManager, barrel file, and unit tests** - `cfdc94ce` (feat)

## Files Created/Modified
- `src/backend/domains/session/acp/types.ts` - AcpProvider, AcpClientOptions, AcpSessionState types
- `src/backend/domains/session/acp/acp-process-handle.ts` - Per-session state wrapper: connection, child process, providerSessionId, agentCapabilities, isPromptInFlight
- `src/backend/domains/session/acp/acp-client-handler.ts` - ACP Client interface implementation with event routing and permission auto-approve
- `src/backend/domains/session/acp/acp-runtime-manager.ts` - AcpRuntimeManager + AcpRuntimeEventHandlers + singleton export
- `src/backend/domains/session/acp/index.ts` - Barrel file exporting all public API
- `src/backend/domains/session/acp/acp-runtime-manager.test.ts` - 25 unit tests
- `package.json` - Added 3 ACP packages (exact versions)
- `pnpm-lock.yaml` - Lock file updated
- `knip.json` - Added ACP binary packages to ignoreDependencies
- `.dependency-cruiser.cjs` - Added acp/ to session-runtime-import-boundary allowlist

## Decisions Made
- Defined `AcpProvider` type inline (`'CLAUDE' | 'CODEX'`) instead of importing `SessionProvider` from providers/ to respect the session-provider-import-boundary dependency-cruiser rule
- Used actual ACP SDK `RequestPermissionOutcome` type structure (`{ outcome: 'selected', optionId }`) instead of the plan's suggested format (`{ selected: { optionId } }`)
- Resolved binary paths via `require.resolve('{package}/package.json')` + reading `bin` field, with fallback to bare command name for PATH resolution
- Added `session_info_update` and `usage_update` to deferred event handling (discovered in SDK `SessionUpdate` type but not mentioned in plan)
- Updated `config_options_update` to `config_option_update` (singular) matching the actual SDK type

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Dependency-cruiser boundary violation for SessionProvider import**
- **Found during:** Task 1 (types.ts creation)
- **Issue:** Importing `SessionProvider` from `providers/session-provider-adapter.ts` violated `session-provider-import-boundary` rule
- **Fix:** Defined `AcpProvider = 'CLAUDE' | 'CODEX'` inline instead of importing
- **Files modified:** `src/backend/domains/session/acp/types.ts`
- **Verification:** `pnpm deps:check` passes
- **Committed in:** 5547f49f (Task 1 commit)

**2. [Rule 3 - Blocking] Dependency-cruiser boundary violation for ProviderRuntimeManager import**
- **Found during:** Task 3 (AcpRuntimeManager creation)
- **Issue:** AcpRuntimeManager importing from `runtime/provider-runtime-manager.ts` violated `session-runtime-import-boundary` rule
- **Fix:** Updated `.dependency-cruiser.cjs` to add `acp/` to the allowlist for the runtime boundary
- **Files modified:** `.dependency-cruiser.cjs`
- **Verification:** `pnpm deps:check` passes
- **Committed in:** 5547f49f (Task 1 commit)

**3. [Rule 1 - Bug] Fixed RequestPermissionResponse format to match actual SDK types**
- **Found during:** Task 2 (AcpClientHandler creation)
- **Issue:** Plan suggested `{ outcome: { selected: { optionId } } }` but actual SDK type requires `{ outcome: { outcome: 'selected', optionId } }`
- **Fix:** Used correct `RequestPermissionOutcome` discriminated union format
- **Files modified:** `src/backend/domains/session/acp/acp-client-handler.ts`
- **Verification:** TypeScript compiles, tests pass
- **Committed in:** 696959d0 (Task 2 commit)

**4. [Rule 2 - Missing Critical] Added handling for session_info_update and usage_update event types**
- **Found during:** Task 2 (AcpClientHandler creation)
- **Issue:** Plan listed event types to handle but missed `session_info_update` and `usage_update` from the SDK's SessionUpdate discriminated union
- **Fix:** Added both to the deferred events case
- **Files modified:** `src/backend/domains/session/acp/acp-client-handler.ts`
- **Verification:** TypeScript exhaustive switch check passes
- **Committed in:** 696959d0 (Task 2 commit)

**5. [Rule 3 - Blocking] knip reported ACP binary packages as unused dependencies**
- **Found during:** Task 1 (package installation)
- **Issue:** `@zed-industries/claude-code-acp` and `@zed-industries/codex-acp` are runtime binaries resolved via `require.resolve`, not static JS imports, so knip flagged them
- **Fix:** Added both to `ignoreDependencies` in `knip.json`
- **Files modified:** `knip.json`
- **Verification:** `pnpm knip` passes
- **Committed in:** 5547f49f (Task 1 commit)

---

**Total deviations:** 5 auto-fixed (1 bug, 1 missing critical, 3 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and tooling compliance. No scope creep.

## Issues Encountered
- Biome lint flagged `async` methods without `await` in AcpClientHandler. These are required by the Client interface contract (returns Promise). Resolved with biome-ignore comments.
- Biome lint flagged non-null assertions for `child.stdout!` and `child.stdin!`. Resolved with explicit null checks and thrown errors.
- Vitest mock hoisting required `vi.hoisted()` pattern for shared mock state between factory functions and tests. Initial approach using top-level class definitions failed because `vi.mock` factories are hoisted above variable declarations.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- ACP runtime module is complete and ready to be wired into `session.service.ts` in Plan 02
- `AcpRuntimeManager` implements `ProviderRuntimeManager<AcpProcessHandle, AcpClientOptions>` interface
- All 25 unit tests pass, typecheck clean, lint clean, dependency-cruiser clean
- No legacy coupling: zero imports from `session/claude/` or ClaudeMessage types

## Self-Check: PASSED

All 6 created files verified on disk. All 3 task commits verified in git log.

---
*Phase: 19-acp-runtime-foundation*
*Completed: 2026-02-13*
