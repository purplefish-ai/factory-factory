# Project Research Summary

**Project:** ACP-Only Provider Runtime Cutover
**Domain:** Agent communication protocol migration
**Researched:** 2026-02-13
**Confidence:** HIGH

## Executive Summary

The ACP cutover replaces Factory Factory's two custom provider protocols (Claude NDJSON and Codex app-server) with the Anthropic Claude Agent SDK V2, which spawns Claude Code as a subprocess. This is not a simple protocol swap—it fundamentally changes three interaction contracts: permissions shift from binary allow/deny to multi-option selection (allow_once/always, reject_once/always), configuration shifts from imperative commands to declarative config options with categories, and sessions move to a unified one-subprocess-per-session model for both providers.

The recommended approach uses `@anthropic-ai/claude-agent-sdk` V2's `unstable_v2_createSession()` and `unstable_v2_resumeSession()` APIs exclusively. The SDK manages subprocess lifecycle, event streaming via async generators, and permission hooks. Factory Factory implements a translation layer that maps SDK message types (`SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`) to existing WebSocket delta events, preserving the frontend contract while exposing new ACP-native data (cost tracking, structured output, permission denials).

The primary risk is process lifecycle complexity: with one subprocess per session, orphaned processes after crashes, resource exhaustion under load, and stdin buffer deadlocks on large payloads become critical concerns. Prevention requires pidfile-based cleanup, non-detached spawn, aggregate process limits, and priority write queues. The second major risk is the permission model transition—failing to carry ACP's full option array through to the UI will break automated workflows and frustrate users with permission fatigue.

## Key Findings

### Recommended Stack

The cutover adds three npm packages and removes all custom protocol code. The Claude Agent SDK V2 (`@anthropic-ai/claude-agent-sdk` via the dependency tree) provides subprocess management and event streaming. The project's existing Zod 4.3.6 satisfies all peer dependencies. No new infrastructure is needed.

**Core technologies:**
- `@anthropic-ai/claude-agent-sdk` (transitive): Session-based API with subprocess lifecycle—used internally by claude-code-acp to manage Claude Code processes
- `@agentclientprotocol/sdk` (0.14.1): ACP protocol runtime with `ClientSideConnection` class for JSON-RPC over stdio—handles framing, serialization, and type-safe callbacks
- `@zed-industries/claude-code-acp` (0.16.1): Claude Code ACP adapter binary spawned as subprocess—wraps Claude agent communication
- `@zed-industries/codex-acp` (0.9.2): Codex ACP adapter binary with platform-specific native binaries—brings Codex under the same runtime

**Critical version notes:** Pin adapter packages to exact versions (no caret). The `@zed-industries/agent-client-protocol` package is deprecated—use `@agentclientprotocol/sdk` exclusively. The SDK V2 API is marked `unstable_v2_*` but is the correct choice for Factory Factory's multi-turn conversation model.

### Expected Features

The ACP cutover must deliver protocol parity plus expose new capabilities. Missing table stakes features mean the cutover is incomplete.

**Must have (table stakes):**
- ACP subprocess lifecycle per session with ClientSideConnection wiring
- Initialize handshake with capability exchange
- Session create/resume via `session/new` and `session/load`
- Prompt send/cancel with streaming response via `session/update` notifications
- Permission option selection with full ACP options (allow_once, allow_always, reject_once, reject_always)
- Frontend permission UI updated to render option choices
- ConfigOptions-driven model/mode/reasoning controls replacing imperative set-model commands
- Frontend config option UI driven by agent-provided configOptions array
- Tool call status rendering with lifecycle (pending, in_progress, completed/failed)
- Process management (clean stop/kill with subprocess cleanup)
- Legacy code removal (Claude NDJSON stack, Codex app-server, all protocol adapters)
- Session file logging for ACP events

**Should have (differentiators):**
- Session resume via `session/load` (capability-gated)
- Unified runtime manager replacing dual Claude/Codex managers
- Config option update reactivity (agent-pushed config changes update UI)
- Tool call file location tracking for follow-along highlighting
- Agent thought rendering in collapsible sections
- Plan rendering with structured task view
- Capability-gated features (conditional UI based on agent capabilities)

**Defer (v2+):**
- `unstable_listSessions` / `unstable_resumeSession` / `unstable_forkSession` (too unstable for cutover milestone)
- MCP server configuration UI (passthrough only)
- Remote/HTTP agent transport (stdio only)
- Terminal management via ACP (agents manage internally)
- File system operations via ACP (agents handle files internally)

### Architecture Approach

Factory Factory's session domain already has a well-factored provider abstraction. The ACP cutover replaces the internals behind `SessionProviderAdapter` and `ProviderRuntimeManager` while preserving the public API consumed by chat handlers and orchestration. The key insight: ACP is not a third provider—it replaces both Claude and Codex with a unified runtime.

**Major components:**
1. `AcpRuntimeManager` — Manages SDK session lifecycle (create, resume, stop, track). One subprocess per session. Maps sessionId to SDK Session handle. Implements `ProviderRuntimeManager` interface.
2. `AcpEventTranslator` — Converts SDK message types to `SessionDeltaEvent` and `CanonicalAgentMessageEvent`. Isolated, testable translation layer following the existing Codex translator pattern.
3. `AcpPermissionHandler` — Promise-based permission lifecycle. Stores pending decisions, resolves when user responds via WebSocket. Replaces ControlRequest/ControlResponse protocol.
4. `AcpSessionProviderAdapter` — Implements `SessionProviderAdapter` interface. Wires runtime manager + event translator + permission handler. Single adapter for both providers.
5. `SessionService` (modified) — Drops dual-adapter dispatch. All sessions go through `AcpSessionProviderAdapter`. Major simplification.
6. `ChatEventForwarderService` (modified) — Rewrite event setup to consume SDK event stream instead of ClaudeClient EventEmitter. Core forwarding logic unchanged.

**Key pattern:** Background event stream consumption via async generator. The SDK V2's `session.stream()` returns an async generator consumed in a detached task, translating each event and forwarding through the existing `sessionDomainService.emitDelta()` pipeline.

### Critical Pitfalls

1. **Orphaned ACP processes after crash** — When FF crashes or is SIGKILL'd, spawned subprocesses continue running. Current system uses `detached: true` and process group kill, which only works during graceful shutdown. Prevention: use non-detached spawn (children receive SIGHUP on parent death), record PIDs to pidfile, clean up stale processes on FF startup. Phase 1 blocker.

2. **Permission model mismatch** — Current system is binary allow/deny. ACP uses option selection with four kinds (allow_once, allow_always, reject_once, reject_always). Mapping to boolean loses allow_always semantics, breaking automated workflows with permission fatigue. Prevention: carry full option array to UI, change `respondToPermission()` from boolean to optionId string. Phase 2 critical path.

3. **Event ordering inversion** — ACP's `session/update` notifications arrive concurrently during prompts. If `turn completed` is mapped to FF's `result` event, the idle handler may dispatch the next queued message before the prompt response resolves, causing overlapping prompts. Prevention: use prompt response (not notifications) as authoritative turn-complete signal. Phase 2 blocker.

4. **stdin buffer deadlock on large prompts** — Base64 images or long system prompts can exceed OS pipe buffer (64KB). If prompt write blocks on drain while agent waits for permission response, both sides deadlock. Prevention: priority write queue that never blocks protocol responses behind prompt content. Phase 1 blocker.

5. **Capability-gating unstable methods** — Methods like `unstable_setSessionModel` and `unstable_resumeSession` may disappear or change. Hard-coding calls without capability checks breaks when users update Claude Code. Prevention: inspect `agentCapabilities` during init, degrade gracefully (disable model selector if not available, fallback to new session if resume unavailable). Phase 1 foundation.

## Implications for Roadmap

Based on research, suggested phase structure follows the critical dependency path:

### Phase 1: ACP Runtime Foundation
**Rationale:** Build the core ACP runtime that can start a session and send/receive a single prompt. Validates the entire subprocess + ClientSideConnection + JSON-RPC pipeline end-to-end. Must be correct from day one—process lifecycle bugs cascade into all subsequent phases.

**Delivers:** Working ACP subprocess spawner, ClientSideConnection wiring, initialize handshake, session/new, session/prompt basic interaction, session/update notification logging.

**Addresses:** Provider launch config, ACP subprocess lifecycle, ClientSideConnection wiring, initialize handshake, session/new, session/prompt + cancel, session/update notification handling, session file logging.

**Avoids:** Pitfall 1 (orphaned processes), Pitfall 4 (stdin deadlock), Pitfall 5 (unstable method capability-gating), Pitfall 6 (resource exhaustion foundation).

**Research flag:** Standard patterns. Subprocess management and JSON-RPC are well-documented. Skip research-phase.

### Phase 2: Event Translation + Permissions
**Rationale:** Make ACP events visible in the FF frontend and handle interactive flows. This is the highest-complexity phase—many SessionUpdate variants, permission model is fundamental UX change. Cannot defer because permissions block automated sessions (ratchet).

**Delivers:** ACP event translation to FF delta events, permission option selection, frontend permission UI with option rendering, tool call status rendering, process management (clean stop/kill).

**Addresses:** Event translation layer, permission option selection, frontend permission UI update, tool call status rendering, process management.

**Avoids:** Pitfall 2 (permission model mismatch), Pitfall 3 (event ordering inversion), Pitfall 11 (cancel semantics).

**Research flag:** Phase needs targeted research on permission UI patterns. The option-selection model is new to Factory Factory and needs UX design.

### Phase 3: Config Options + Unified Runtime
**Rationale:** Add configuration controls and consolidate runtime management. ConfigOptions replace three separate imperative controls (model, mode, thinking). Unified runtime eliminates dual-manager complexity.

**Delivers:** ConfigOptions-driven model/mode/reasoning controls, frontend config option UI with category grouping, config option update reactivity, unified runtime manager for both providers.

**Addresses:** Config options parsing and state management, frontend config selectors by category, agent-pushed config updates, unified AcpRuntimeManager.

**Avoids:** Pitfall 7 (config race conditions), Pitfall 8 (mode category conflation).

**Research flag:** Standard patterns. Config UI is CRUD. Skip research-phase.

### Phase 4: Cleanup + Polish
**Rationale:** Remove legacy code and add differentiator features. Cannot remove old code until new code is proven stable in production.

**Delivers:** Legacy protocol deletion (Claude NDJSON stack, Codex app-server, old adapters), session/load support (capability-gated), health reporting for per-session processes, capability-gated feature toggles.

**Addresses:** Legacy code removal, session/load, health reporting, capability-gated features.

**Avoids:** Pitfall 9 (stale session store).

**Research flag:** Standard patterns. Deletion is straightforward. Skip research-phase.

### Phase Ordering Rationale

- Phase 1 must come first because process lifecycle is foundational. Bugs here cascade into all downstream work. The validation criteria (can start session, send prompt, receive response) is minimal but sufficient to prove the ACP integration works end-to-end.
- Phase 2 must come second because permissions block automated workflows (ratchet auto-fix). Event translation is the most complex piece—many variants, ordering subtleties. Cannot defer without breaking core UX.
- Phase 3 can come third because config options are user-facing polish, not blocking. The unified runtime manager is architectural cleanup that reduces complexity but does not change behavior.
- Phase 4 cleanup cannot happen until Phase 3 is stable. Old code is the rollback path.

Critical path: Phase 1 → Phase 2 (most complexity) → Phase 3 → Phase 4. Phases 1-2 are tight, Phase 3-4 can stretch.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** Permission UI patterns—the option-selection model needs UX design. Research existing permission UIs with always/never options (browser permissions, mobile app permissions).

Phases with standard patterns (skip research-phase):
- **Phase 1:** Subprocess management and JSON-RPC are well-documented Node.js patterns
- **Phase 3:** Config UI is standard CRUD
- **Phase 4:** Deletion and capability-gating are straightforward

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified via npm. Zod compatibility confirmed. SDK API surface documented. |
| Features | HIGH | ACP specification is official Anthropic docs. Feature dependencies verified from protocol spec and existing codebase analysis. |
| Architecture | HIGH | Existing codebase thoroughly analyzed. Provider abstraction layer is well-factored. Component boundaries are clear. SDK V2 API maps naturally to FF's request-response flow. |
| Pitfalls | HIGH | Process lifecycle pitfalls verified from existing Claude/Codex code. Event ordering and permission model risks identified from protocol differences. ACP protocol edge cases are MEDIUM confidence (protocol is young, limited production war stories). |

**Overall confidence:** HIGH

### Gaps to Address

- **SDK V2 stability timeline:** The V2 API is marked `unstable_v2_*`. Mitigation: pin SDK version, wrap in thin adapter layer. Accept unstable prefix—API surface is small and well-defined.
- **`canUseTool` vs `PermissionRequest` hooks:** SDK offers both. Research suggests `canUseTool` is more natural for FF (returns PermissionResult directly). Needs experimentation in Phase 2.
- **SDK subprocess cleanup reliability:** Does SDK clean up subprocesses on `session.close()`? Need to verify orphan behavior under crash scenarios. Fallback: PID tracking.
- **Transcript hydration via SDK resume:** Does `resumeSession()` provide enough data for FF's transcript hydration, or does FF still need to read Claude's JSONL files? Test during Phase 1.
- **Event stream backpressure:** The SDK V2 `session.stream()` async generator could buffer if FF's event processing is slow. Need to verify background consumption loop handles backpressure correctly. Test under load in Phase 2.

## Sources

### Primary (HIGH confidence)
- [@agentclientprotocol/sdk on npm](https://www.npmjs.com/package/@agentclientprotocol/sdk) — v0.14.1 verified 2026-02-13
- [@zed-industries/claude-code-acp on npm](https://www.npmjs.com/package/@zed-industries/claude-code-acp) — v0.16.1 verified 2026-02-13
- [@zed-industries/codex-acp on npm](https://www.npmjs.com/package/@zed-industries/codex-acp) — v0.9.2 verified 2026-02-13
- [ACP TypeScript SDK GitHub](https://github.com/agentclientprotocol/typescript-sdk) — ClientSideConnection API and examples
- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview) — Protocol lifecycle and message types
- [ClientSideConnection API Reference](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html) — Full method signatures
- [ACP Protocol Specification](https://github.com/agentclientprotocol/agent-client-protocol) — Schema and JSON-RPC method definitions
- [ACP Prompt Turn spec](https://agentclientprotocol.com/protocol/prompt-turn) — Prompt flow, stop reasons, cancellation
- [ACP Tool Calls spec](https://agentclientprotocol.com/protocol/tool-calls) — Permission requests, option kinds, status lifecycle
- [ACP Session Config Options](https://agentclientprotocol.com/protocol/session-config-options) — Config option structure and categories
- [Claude Agent SDK TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) — V2 session-based API
- Factory Factory codebase: `src/backend/domains/session/` — Existing protocol stack, providers, runtime managers, chat handlers

### Secondary (MEDIUM confidence)
- [claude-code-acp GitHub](https://github.com/zed-industries/claude-code-acp) — Adapter architecture and event translation
- [codex-acp GitHub](https://github.com/zed-industries/codex-acp) — Rust adapter, terminal handling, auth methods
- [Zed blog: Claude Code via ACP](https://zed.dev/blog/claude-code-via-acp) — Adapter design rationale
- [DeepWiki: claude-code-acp](https://deepwiki.com/zed-industries/claude-code-acp) — Detailed architecture and permission system
- [Kiro ACP CLI Documentation](https://kiro.dev/docs/cli/acp/) — Practical implementation guidance
- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html) — Detached processes, process groups, stdio pipe behavior
- [MCP Lifecycle Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle) — stdio shutdown sequence

### Tertiary (LOW confidence)
- [Intro to Agent Client Protocol (ACP)](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/) — Protocol design rationale
- [Cline ACP Implementation](https://deepwiki.com/cline/cline/12.5-agent-client-protocol-(acp)) — Real-world ACP integration patterns

---
*Research completed: 2026-02-13*
*Ready for roadmap: yes*
