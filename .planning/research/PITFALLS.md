# Domain Pitfalls: ACP-Only Provider Runtime Cutover

**Domain:** Replacing custom Claude NDJSON + Codex app-server protocols with unified ACP stdio adapter
**Researched:** 2026-02-13
**Confidence:** HIGH for process lifecycle and event translation pitfalls (codebase evidence + established Node.js patterns), MEDIUM for ACP protocol edge cases (protocol is young, limited production war stories)

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or production outages.

### Pitfall 1: Orphaned ACP Processes After FF Crash or SIGKILL

**What goes wrong:**
When Factory Factory crashes (unhandled exception, SIGKILL from OOM, or Electron force-quit), spawned ACP stdio subprocesses continue running indefinitely. The current Claude process manager spawns with `detached: true` (line 96 of `claude/process.ts`) to create process groups, and uses `process.kill(-pid, 'SIGKILL')` for cleanup (line 243). But this only works during graceful shutdown. If FF itself is killed with SIGKILL, the process group kill never executes. With process-per-session, 5 active sessions means 5 orphaned ACP processes, each consuming memory and potentially holding file locks on workspace directories.

**Why it happens:**
The existing `ClaudeProcess.killProcessGroup()` and `ClaudeRuntimeManager.stopAllClients()` rely on the Node.js process being alive to execute cleanup. There is no external reaper. The current system has this same risk with Claude CLI processes, but it is mitigated by the fact that Claude CLI processes are relatively self-terminating (they exit when stdin closes, which happens when the parent process dies). ACP adapters may or may not exhibit this behavior depending on the agent implementation.

**Consequences:**
- Zombie ACP processes consuming memory (potentially 200-500MB each for agent processes)
- File descriptor exhaustion on the host (each process holds stdio pipes + agent-internal FDs)
- Workspace directory file locks preventing subsequent session starts
- On Electron, users see "port already in use" or "file locked" errors on next app launch

**Prevention:**
- Record PIDs to a pidfile on disk (`~/.factory-factory/acp-processes.pid`) on spawn, remove on exit. On FF startup, check for stale pidfiles and kill any surviving processes.
- Do NOT use `detached: true` for ACP processes. When the parent dies, non-detached children receive SIGHUP, which most processes handle by exiting. Detached processes survive parent death by design.
- Register a `process.on('exit')` handler (which fires even on SIGINT/SIGTERM) that does a synchronous best-effort process group kill.
- For Electron builds, use `app.on('before-quit')` to trigger graceful shutdown of all ACP processes before the Node.js process exits.

**Detection:**
- `ps aux | grep acp` showing processes with no FF parent
- Memory usage growing after FF restart without new sessions
- File lock errors when starting sessions in workspaces that had active sessions before a crash

**Phase to address:** Phase 1 (ACP Process Spawner). Process lifecycle must be correct from day one. Orphan cleanup cannot be deferred.

---

### Pitfall 2: Permission Model Mismatch -- Boolean Allow/Deny vs. ACP Option Selection

**What goes wrong:**
The current Claude permission system is binary: `PermissionHandler.onCanUseTool()` returns either `{ behavior: 'allow', updatedInput: {} }` or `{ behavior: 'deny', message: '...' }` (see `permissions.ts` lines 64-77). The existing UI presents approve/deny buttons and the `respondToPermission()` method in `claude-session-provider-adapter.ts` (line 141) takes a boolean `allow` parameter.

ACP's `session/request_permission` uses a fundamentally different model: the agent sends an array of `PermissionOption` objects, each with an `optionId`, `name` (display label), and `kind` (one of `allow_once`, `allow_always`, `reject_once`, `reject_always`). The response is an `optionId` string, not a boolean.

Naively mapping this to the existing boolean model means losing `allow_always` and `reject_always` semantics. This breaks the core UX improvement of ACP permissions: once a user says "always allow Bash in this directory," they should not be asked again. If FF strips that to a one-time allow, the agent will re-prompt on every subsequent Bash invocation, making the tool unusable for automated workflows (ratchet auto-fix sessions).

**Why it happens:**
The existing `DeferredHandler` and `ModeBasedHandler` classes in `permissions.ts` are designed around the binary model. The `PendingInteractiveRequest` type in the shared types only stores `requestId`, `toolName`, `toolUseId`, and `input`. There is no field for option arrays. The `permission_request` delta event type in `websocket.ts` (line 98-104) sends `toolName` and `toolInput` but no options.

**Consequences:**
- Automated sessions (ratchet auto-fix) cannot benefit from `allow_always` and will be blocked by repeated permission prompts
- Users are frustrated by permission fatigue -- approving the same tool repeatedly
- The FF permission mode system (`bypassPermissions`, `acceptEdits`, `dontAsk`, `default`) has no clean mapping to ACP option selection
- If the mapping is done wrong, security-sensitive denials (`reject_always`) are silently downgraded to `reject_once`

**Prevention:**
- Design the new permission bridge to be option-aware from the start. The internal `PendingInteractiveRequest` must carry the full `PermissionOption[]` array from the agent.
- Add a new `permission_request` delta event shape that includes `options: Array<{ optionId: string, name: string, kind: string }>`.
- For automated sessions (ratchet), implement a permission strategy that maps FF's `bypassPermissions` mode to always selecting the `allow_always` option (if available) or `allow_once` as fallback.
- For interactive sessions in `default` mode, present the full ACP option set in the UI. Do not reduce to boolean.
- The `respondToPermission()` method must change from `(sessionId, requestId, allow: boolean)` to `(sessionId, requestId, optionId: string)`.

**Detection:**
- Automated sessions getting stuck waiting for permission responses
- Users reporting they have to approve the same tool multiple times per session
- Permission response handler throwing "unknown optionId" errors

**Phase to address:** Phase 2 (Event Translation Layer). The permission model is a UI + backend + protocol change that spans multiple layers. It must be designed holistically, not as a backend afterthought.

---

### Pitfall 3: Event Ordering Inversion During ACP-to-FF State Translation

**What goes wrong:**
The existing event forwarder (`chat-event-forwarder.service.ts`) processes events sequentially from a single `ClaudeClient` EventEmitter. Events arrive in-order because they come from a single stdio readline stream. The forwarder makes assumptions about ordering: `tool_use` events always precede their corresponding `tool_result` events, `session_id` arrives before the first `stream` event, and `result` events mark the end of a turn.

ACP's `session/update` notifications have different ordering guarantees. The `session/prompt` method is a request-response pair where the response contains the `stopReason`, but `session/update` notifications arrive concurrently during the prompt. An agent may send `tool_call` updates, `agent_message_chunk` updates, and `config_option_update` notifications interleaved in ways that do not match Claude CLI's sequential NDJSON stream.

The critical failure: if the ACP adapter translates `turn completed` into FF's `result` event, the `idle` handler in `chat-event-forwarder.service.ts` (line 286) fires and calls `onDispatchNextMessage()`, potentially sending the next queued message before the prompt response has been fully processed. This creates a race between "prompt response arrives" and "next message dispatched."

**Why it happens:**
The existing Codex translator (`codex-event-translator.ts`) already deals with a similar problem -- it maps `turn/started`, `turn/completed`, `turn/interrupted` notifications to FF runtime state changes. But the Codex adapter uses a single shared process (app-server model), so it already has a serialization point (the `CodexAppServerManager.handleInbound()` method processes messages synchronously). An ACP process-per-session model means each session has its own independent event stream, and the events must be translated and applied atomically.

**Consequences:**
- Queued messages dispatched while the previous turn is still completing, causing the agent to receive overlapping prompts
- Runtime state machine (`session-runtime-machine.ts`) receiving out-of-order phase transitions (e.g., `idle` -> `running` -> `idle` when it should be `running` -> `idle`)
- UI showing flickering between WORKING and IDLE states
- Transcript messages appearing out of order in the chat view

**Prevention:**
- The ACP event translator must maintain a per-session state machine that tracks whether a prompt is in-flight. The `session/prompt` response (not a notification) is the authoritative signal that a turn is complete.
- Do not derive "idle" from notifications alone. Use the prompt response resolution as the single source of truth for turn completion.
- Gate the `onDispatchNextMessage()` callback on the prompt response, not on a translated `result` event.
- Add an integration test that sends a prompt, fires interleaved notifications, and verifies the session does not dispatch the next queued message until the prompt response resolves.

**Detection:**
- Log entries showing "dispatching next message" before "prompt response received" for the same session
- UI chat showing user messages appearing between tool results from the same turn
- Runtime state machine emitting `running` -> `idle` -> `running` in rapid succession (< 100ms)

**Phase to address:** Phase 2 (Event Translation Layer). The translation layer is the most complex part of the cutover and the most likely to have ordering bugs.

---

### Pitfall 4: stdin Buffer Deadlock on Large Prompt Payloads

**What goes wrong:**
The existing `ClaudeProtocol.sendRaw()` method (line 434 of `protocol.ts`) correctly handles backpressure: when `stdin.write()` returns `false`, it waits for the `drain` event before continuing. However, it does so with a single pending drain promise, meaning writes are serialized.

With ACP, the client may need to send a `session/prompt` request containing large content (base64-encoded images, long system prompts) while simultaneously needing to respond to a `session/request_permission` request from the agent. If the prompt write fills the stdin buffer and blocks on drain, the permission response cannot be sent. But the agent may be waiting for the permission response before it can continue processing, which means it will not read from its stdin (which is FF's stdout), which means the drain event never fires. This is a classic pipe buffer deadlock.

The existing system avoids this because Claude CLI's NDJSON protocol is half-duplex in practice: FF sends a user message, then waits for the response. Control requests (permissions) come from the CLI and FF responds, but FF never initiates a new write while waiting for a previous write to drain.

ACP is inherently full-duplex: the client can send prompts, config changes, and permission responses concurrently with the agent sending notifications and permission requests.

**Why it happens:**
Node.js stdio pipe buffers are typically 64KB on macOS and 65KB on Linux. A single base64-encoded image can be 500KB+. The `stream.write()` call will buffer the entire payload in Node.js memory and return `false`, but the OS pipe buffer fills up and creates backpressure. If the agent-side pipe buffer also fills (because the agent is blocked waiting for a permission response), both sides are deadlocked.

**Consequences:**
- Session appears to hang indefinitely -- no error, no timeout, just frozen
- The hung process monitor will eventually kill the process after 30 minutes (the default `activityTimeoutMs`), but that is far too slow
- Multiple sessions can deadlock simultaneously if they all have large prompts

**Prevention:**
- Implement a write queue that prioritizes protocol responses (permission responses, cancel notifications) over prompt requests. Protocol responses must never be blocked behind a pending prompt write.
- Consider using separate write channels: one for request-response protocol messages and one for prompt content. ACP does not support this natively over stdio, but the write queue achieves the same effect.
- Set a write timeout (e.g., 10 seconds) on any single `stdin.write()` call. If the write does not complete within the timeout, kill the process and report an error.
- Reduce prompt payload size by using file references instead of inline content where possible.

**Detection:**
- Session stuck in "running" with no activity for > 30 seconds
- `stdin.writableLength` growing monotonically (check via periodic monitoring)
- Agent stderr showing "stdin buffer full" or similar backpressure warnings

**Phase to address:** Phase 1 (ACP Process Spawner). The write path must be correct from the first prototype. A deadlock in the write path makes the entire system unusable.

---

### Pitfall 5: Capability-Gating Unstable Methods Without Version Awareness

**What goes wrong:**
ACP has several methods explicitly marked as unstable in the TypeScript SDK: `unstable_resumeSession`, `unstable_listSessions`, `unstable_forkSession`, `unstable_setSessionModel`. These methods may be removed or changed without notice. FF needs at least `unstable_setSessionModel` (for the model selector) and `unstable_resumeSession` (for session resume after process restart).

The pitfall is hard-coding calls to these methods without checking agent capabilities during initialization. When a new version of Claude Code (or another ACP agent) ships without these methods, the call fails at runtime. Worse, if the method signature changes (e.g., `unstable_setSessionModel` becomes `session/set_model` with different params), the existing call silently sends the wrong method name and gets a JSON-RPC "method not found" error.

**Why it happens:**
During development, the team tests against a specific version of Claude Code that supports all unstable methods. The CI also pins a specific version. The failure only manifests when users update their Claude Code installation independently of FF.

**Consequences:**
- Model selector silently fails -- user changes model, no error shown, agent continues using previous model
- Session resume fails, forcing a new session (losing conversation history)
- Error messages are cryptic JSON-RPC errors that mean nothing to users

**Prevention:**
- During `initialize`, inspect the agent's `agentCapabilities` response. Build a capabilities map that tracks which unstable methods are available.
- Before calling any unstable method, check the capabilities map. If the method is not available, degrade gracefully:
  - `unstable_setSessionModel` not available: disable the model selector in the UI, show a tooltip explaining the agent does not support model switching
  - `unstable_resumeSession` not available: fall back to `session/load` (if `loadSession` capability is present) or create a new session
  - `unstable_listSessions` not available: disable the session picker
  - `unstable_forkSession` not available: disable fork functionality
- Log a warning (not error) when a capability is missing. This is expected behavior, not a bug.
- When unstable methods graduate to stable (e.g., `unstable_setSessionModel` becomes `session/set_model`), support both method names with a capability check to determine which to use.

**Detection:**
- Users reporting "model selector does nothing" after updating Claude Code
- JSON-RPC "method not found" errors in session logs
- Session resume silently creating new sessions instead of continuing existing ones

**Phase to address:** Phase 1 (ACP Process Spawner / Initialize). Capability checking must be built into the initialization flow, not bolted on later.

---

### Pitfall 6: Process-Per-Session Resource Exhaustion Under Load

**What goes wrong:**
The current system has two models: Claude uses process-per-session (spawning a `claude` CLI process for each session), and Codex uses a shared app-server process (one process handling all sessions via multiplexed JSON-RPC). Moving to ACP means all providers use process-per-session.

With the Codex shared-process model gone, a user with 10 workspaces each having 2 sessions (a primary and an auto-fix session) would have 20 ACP processes running simultaneously. Each process includes: the ACP adapter binary, the agent runtime (Claude Code, Codex CLI, etc.), any MCP servers the agent spawns, and associated memory for conversation context.

The existing `ClaudeProcessMonitor` (in `monitoring.ts`) monitors memory per-process with a 10GB ceiling and uses `pidusage` for resource tracking. But it monitors individual processes, not aggregate resource consumption. Twenty processes each using 500MB is 10GB total -- within each process's individual limit but catastrophic for the system.

**Why it happens:**
The current system rarely has more than 3-5 Claude processes active simultaneously because Codex sessions use the shared server. Ratchet auto-fix sessions are short-lived. The process-per-session count was low enough that aggregate monitoring was unnecessary.

**Consequences:**
- System runs out of memory, triggering OOM killer (which may kill FF itself, leading to Pitfall 1)
- File descriptor exhaustion (each process uses ~10 FDs for stdio + internal operations; 20 processes = 200 FDs)
- macOS launchd throttling: spawning too many processes too quickly triggers launchd's `spawn_via_launchd` throttle
- Electron app becomes unresponsive as the host system swaps

**Prevention:**
- Add an aggregate process limit (e.g., max 8 concurrent ACP processes). Queue additional session starts until a slot opens. The existing `session-queue.ts` pattern can be extended for this.
- Add aggregate memory monitoring: sum `pidusage` results across all ACP processes. If total exceeds a threshold (e.g., 60% of system memory), refuse to spawn new processes and warn the user.
- Implement idle process reaping: if a session has been idle for > 10 minutes and there are queued session starts waiting, gracefully stop the idle session's process (the session state is preserved; it just needs a new process to resume).
- For ratchet auto-fix sessions, consider a pool of reusable ACP processes rather than spawn-per-fix. When an auto-fix session completes, return the process to the pool instead of killing it.

**Detection:**
- System memory usage > 80% with multiple ACP processes visible in Activity Monitor
- New session starts failing with ENOMEM or EAGAIN errors
- Existing sessions becoming slow or unresponsive as system swaps

**Phase to address:** Phase 1 (ACP Process Spawner) for the aggregate limit. Phase 3 (Optimization) for idle reaping and process pooling.

---

## Moderate Pitfalls

### Pitfall 7: Config Option Synchronization Race Between UI and ACP Process

**What goes wrong:**
ACP's `session/set_config_option` returns the full set of config options and their current values, because changing one option may affect others. FF's current model sends fire-and-forget config changes: `ClaudeProtocol.sendSetModel()` (line 261 of `protocol.ts`) sends a message and does not wait for acknowledgment. `sendSetMaxThinkingTokens()` is similarly fire-and-forget.

If the user rapidly changes model then thinking budget, and the model change causes the thinking budget options to change (e.g., a model that does not support extended thinking), the second request may reference a thinking budget value that is no longer valid. The ACP agent would reject it, but FF has already updated its UI optimistically.

**Prevention:**
- Serialize config changes per session. Use a queue (similar to `pLimit(1)` in `ClaudeRuntimeManager`) that ensures only one config change is in-flight at a time.
- Wait for the `session/set_config_option` response before sending the next config change.
- On response, update the UI with the agent's authoritative config state, not the optimistically-set value.
- Handle `config_option_update` notifications from the agent that may arrive asynchronously (e.g., when the agent auto-adjusts config based on context).

**Detection:**
- UI showing a model/thinking configuration that does not match what the agent is actually using
- Config change requests returning errors that the UI does not display
- Thinking budget selector showing options that are invalid for the current model

**Phase to address:** Phase 3 (Config Synchronization).

---

### Pitfall 8: ACP Mode Categories Conflating Model, Mode, and Thought Level

**What goes wrong:**
ACP supports `session/set_mode` with mode categories: `mode`, `model`, `thought_level`, and custom `_`-prefixed variants. These are semantically distinct in ACP but map to three separate controls in FF's current UI: the model selector, the permission/execution mode selector, and the thinking budget slider.

The pitfall is treating ACP modes as a flat list. A mode change of category `model` should update the model selector. A mode change of category `thought_level` should update the thinking slider. A mode change of category `mode` should update the execution mode. If these are conflated, changing the model might unexpectedly reset the thinking level, or changing the execution mode might switch the model.

**Prevention:**
- Parse the `category` field on each mode and route to the appropriate UI control.
- When `session/new` returns `modes` in its response, partition them by category and populate each UI control independently.
- Handle `current_mode_update` notifications that may arrive when changing one category affects another (e.g., selecting a model that forces a specific thinking level).

**Detection:**
- Changing model unexpectedly resets thinking budget in the UI
- Mode selector showing model names mixed with execution modes
- `session/set_mode` calls failing because the wrong modeId is sent for the category

**Phase to address:** Phase 2 (Event Translation Layer) for mapping, Phase 3 for full UI integration.

---

### Pitfall 9: Stale Session Store After Process Restart Without Transcript Replay

**What goes wrong:**
When an ACP process dies unexpectedly and FF restarts it, the new process has no knowledge of the previous conversation. The current system handles this for Claude via `--resume <sessionId>` which tells Claude CLI to load its JSONL transcript from disk. For Codex, the `thread/read` method hydrates the session from the Codex server's state.

With ACP, session restoration uses `session/load` (if the agent supports `loadSession` capability) or `unstable_resumeSession`. If the agent does not support either, the session state in FF's `SessionStore` (transcript, pending requests, queue) becomes orphaned -- it references a conversation the agent no longer knows about.

The existing `handleProcessExit()` function in `session-process-exit.ts` resets the store (clears queue, transcript, pending requests) and then attempts to rehydrate from the Claude JSONL file. This works because Claude CLI writes transcript to disk. ACP agents may or may not persist session state externally.

**Prevention:**
- During initialization, check for `loadSession` capability. If absent, FF must persist enough session state locally to reconstruct the conversation on reconnect.
- When an ACP process exits unexpectedly, do NOT immediately clear the store. Instead, attempt to restart the process and load the session. Only clear the store if session loading fails.
- Implement a local session transcript log (similar to the existing `session-file-logger.service.ts`) that records ACP events in a format that can be replayed to a new session via `session/prompt` if native session loading is unavailable.
- Surface session restoration failures to the user: "Session could not be restored. Start a new session?"

**Detection:**
- After process restart, agent responding as if it has no prior context
- Chat UI showing previous messages but agent unaware of them
- "Session not found" errors from `session/load` calls

**Phase to address:** Phase 2 (Session Lifecycle). Session restoration is core to the UX.

---

### Pitfall 10: JSON-RPC ID Collision Between FF Requests and Agent Requests

**What goes wrong:**
ACP uses JSON-RPC 2.0 where both the client (FF) and agent can send requests with `id` fields. The current Codex app-server manager uses a simple incrementing integer for request IDs (`this.requestId++` on line 129 of `codex-app-server-manager.ts`). If the ACP agent also uses incrementing integers for its server-to-client requests (like `session/request_permission`), the IDs can collide. A response intended for a permission request might be matched to a prompt request, or vice versa.

**Prevention:**
- Use UUID strings for client-to-agent request IDs, not integers. The JSON-RPC 2.0 spec allows strings.
- The existing `ClaudeProtocol` already uses `randomUUID()` for request IDs (line 141 of `protocol.ts`). Carry this pattern forward.
- In the response handler, validate that the response `id` matches a known pending request before processing. The existing `pendingRequests` Map pattern handles this.
- Never assume that an inbound message with an `id` field is a response. It could be a server-to-client request. Check for the presence of `method` to distinguish requests from responses.

**Detection:**
- Permission responses being swallowed (matched to a different pending request)
- Prompt responses containing permission-related data
- "Unknown request ID" warnings in logs

**Phase to address:** Phase 1 (ACP Protocol Layer). ID management is fundamental to JSON-RPC correctness.

---

### Pitfall 11: `session/cancel` Notification Semantics vs. FF's Interrupt Model

**What goes wrong:**
FF's current interrupt model sends an `interrupt` control request via the NDJSON protocol (`ClaudeProtocol.sendInterrupt()` on line 241), then waits 5 seconds for the process to exit before force-killing (`ClaudeProcess.interrupt()` on line 202-228). This is a graceful-then-forceful shutdown.

ACP's `session/cancel` is a notification (no response expected), and the agent is expected to stop LLM requests, abort tool invocations, and respond to the in-flight `session/prompt` request with `StopReason::Cancelled`. But the ACP spec does not define a timeout for how quickly the agent must respond to cancel.

If FF sends `session/cancel` and then immediately force-kills the process (as the current 5-second timeout does), the agent may not have time to clean up. Conversely, if FF waits too long, the user perceives the cancel as broken.

**Prevention:**
- After sending `session/cancel`, wait for the in-flight `session/prompt` to resolve (with `stopReason: 'Cancelled'`) rather than using a fixed timeout.
- Set a generous but bounded timeout (e.g., 15 seconds) for the prompt response after cancel. If the prompt does not resolve, escalate to SIGTERM then SIGKILL.
- Do not kill the process just because cancel was requested. The user may want to send another prompt after cancelling the current one.
- Track whether a cancel is "stop this prompt" (soft cancel -- keep process alive) vs. "stop this session" (hard cancel -- kill process). Map FF's "stop" button to soft cancel and FF's "stop session" action to hard cancel.

**Detection:**
- Agent process killed while writing a partial tool result, leaving workspace in inconsistent state
- Cancel appearing to do nothing (prompt continues for 15+ seconds after cancel)
- Process killed and session needs full restart just to cancel a prompt

**Phase to address:** Phase 2 (Session Lifecycle).

---

## Minor Pitfalls

### Pitfall 12: stderr Pollution From ACP Agent Contaminating Protocol Stream

**What goes wrong:**
ACP uses stdout for JSON-RPC messages. Some ACP agents log debug output to stderr, which is harmless. But if an agent (or a library it loads) accidentally writes to stdout, those bytes get mixed into the JSON-RPC stream and cause parse errors. The current `ClaudeProtocolIO` handles this by logging unparseable lines (line 512-526 of `protocol.ts`), but a malformed line can also corrupt a subsequent line if it splits a JSON message across a newline boundary.

**Prevention:**
- Use a robust NDJSON parser that can recover from malformed lines (the existing `processLine` approach of skipping unparseable lines is correct).
- Buffer partial JSON: if a line does not parse as valid JSON, check if concatenating it with the next line produces valid JSON (handles the case where a log message splits a JSON-RPC message).
- Redirect agent stderr to the session file logger for debugging, not to the FF process stderr.

**Phase to address:** Phase 1 (ACP Protocol Layer).

---

### Pitfall 13: ACP SDK Version Drift Between FF and Agent

**What goes wrong:**
FF uses the `@agentclientprotocol/sdk` TypeScript package to implement the client side. The agent (Claude Code, Codex CLI) uses its own ACP implementation. If FF's SDK is newer than the agent's, FF may call methods the agent does not understand. If the agent's SDK is newer, it may send notifications FF does not handle.

**Prevention:**
- Pin the ACP SDK version in `package.json` and document the minimum agent version required.
- During `initialize`, compare `protocolVersion` values. If they differ, log a warning and disable methods that may not be supported.
- Handle unknown notification methods gracefully (log and ignore, do not throw).
- Handle unknown fields in responses gracefully (Zod schemas with `.passthrough()` or `.strip()`).

**Phase to address:** Phase 1 (initialization).

---

### Pitfall 14: Test Mocking Complexity for stdio-Based ACP Processes

**What goes wrong:**
The existing test suite mocks `ClaudeClient` and `ClaudeProcess` at the class level (see `claude-runtime-manager.test.ts`, `claude-session-provider-adapter.test.ts`). With ACP, tests need to mock a full JSON-RPC 2.0 conversation over stdio streams. This includes: initialization handshake, capability exchange, async notifications interleaved with responses, and bidirectional request flows (both client-to-agent and agent-to-client requests happening concurrently).

Mocking this correctly is hard. Getting it wrong means tests pass but production breaks because the mock does not replicate real event ordering.

**Prevention:**
- Build a `MockAcpAgent` test utility that implements the server side of the ACP protocol over in-memory streams (using `PassThrough` streams from Node.js). This utility should support: scripted responses, async notification injection, configurable capability sets, and deliberate error injection.
- Write the mock agent once and reuse it across all tests. Do not hand-craft JSON-RPC messages in each test.
- Include at least one integration test that spawns a real ACP agent process (even if it is a minimal test agent) to verify the stdio transport works end-to-end.
- For the event translator tests, use the existing Codex translator test patterns (`codex-event-translator.test.ts`) as a template -- they already test notification-to-delta mapping.

**Phase to address:** Phase 1 (ACP Protocol Layer). The test infrastructure must exist before implementation begins.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| **Phase 1: ACP Process Spawner** | Orphaned processes after crash (Pitfall 1) | Pidfile + non-detached spawn + startup cleanup sweep |
| **Phase 1: ACP Process Spawner** | stdin deadlock on large payloads (Pitfall 4) | Priority write queue separating protocol responses from prompt content |
| **Phase 1: ACP Process Spawner** | Capability-gating unstable methods (Pitfall 5) | Check `agentCapabilities` during init, degrade gracefully per method |
| **Phase 1: ACP Process Spawner** | Resource exhaustion under load (Pitfall 6) | Aggregate process limit, aggregate memory monitoring |
| **Phase 2: Event Translation** | Event ordering inversion (Pitfall 3) | Use prompt response (not notifications) as turn-complete signal |
| **Phase 2: Event Translation** | Permission model mismatch (Pitfall 2) | Carry full ACP options through to UI, do not reduce to boolean |
| **Phase 2: Event Translation** | Mode category conflation (Pitfall 8) | Route ACP modes by category to correct UI controls |
| **Phase 2: Session Lifecycle** | Stale store after process restart (Pitfall 9) | Check `loadSession` capability, persist local transcript as fallback |
| **Phase 2: Session Lifecycle** | Cancel semantics mismatch (Pitfall 11) | Wait for prompt response after cancel, distinguish soft/hard cancel |
| **Phase 3: Config Sync** | Config race conditions (Pitfall 7) | Serialize config changes per session, wait for response before next change |
| **Phase 3: Optimization** | Process-per-session resource pressure (Pitfall 6) | Idle process reaping, process pool for auto-fix sessions |
| **All phases** | Test mocking complexity (Pitfall 14) | Build `MockAcpAgent` utility in Phase 1, reuse everywhere |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces:

- [ ] **Process spawner:** Tests pass with mock, but no test verifies cleanup after `process.kill(process.pid, 'SIGKILL')` on the FF process itself
- [ ] **Permission flow:** Happy path works, but no test verifies what happens when the user responds to a permission request after the agent has already cancelled it (race between user click and `permission_cancelled` notification)
- [ ] **Event translator:** All ACP notification types are handled, but no test verifies behavior for unknown notification methods (should log and ignore, not crash)
- [ ] **Session resume:** Resume works when agent supports `loadSession`, but no fallback tested for agents that do not advertise this capability
- [ ] **Config sync:** Model change works, but no test verifies that a model change that invalidates the current thinking budget triggers a UI update to the thinking selector
- [ ] **Cancel flow:** Cancel during idle works, but no test verifies cancel during a permission prompt (agent waiting for FF, FF sends cancel, agent should resolve prompt with Cancelled)
- [ ] **Write path:** Normal-size messages work, but no test verifies behavior when a message exceeds the OS pipe buffer size (64KB+)
- [ ] **Shutdown:** Graceful shutdown works, but no test verifies that all ACP processes are killed when Electron's `app.quit()` fires
- [ ] **Provider removal:** ACP adapter is complete, but the old Claude NDJSON protocol files and Codex app-server files are still in the codebase (dead code)
- [ ] **Aggregate monitoring:** Per-process monitoring works, but no aggregate memory or process count monitoring exists

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover:

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Orphaned processes (1) | LOW | Kill manually (`pkill -f acp`). Deploy pidfile cleanup. No data loss since agent state is persisted by the agent. |
| Permission model mismatch (2) | MEDIUM | Ship UI update to show ACP options. Requires frontend + backend changes. Automated sessions may need config change. |
| Event ordering inversion (3) | MEDIUM | Fix translator ordering logic. Queued messages may have been sent prematurely -- no data loss but conversation context may be muddled. |
| stdin deadlock (4) | LOW | Kill the stuck process (hung process monitor does this). Fix write queue prioritization. Session restarts cleanly. |
| Unstable method breakage (5) | LOW | Feature degrades gracefully if capability checks are in place. Update SDK or method names. No data loss. |
| Resource exhaustion (6) | MEDIUM | Reduce concurrent session limit. Kill idle processes. May require FF restart to recover memory. No data loss. |
| Config race condition (7) | LOW | Config self-corrects on next response. User may need to re-set config. No lasting damage. |
| Mode conflation (8) | LOW | UI shows wrong control state but agent has correct state. Fix UI routing. |
| Stale session store (9) | HIGH | If local transcript fallback is missing and agent cannot restore session, conversation history is lost. This is the highest-risk pitfall for user data. |
| JSON-RPC ID collision (10) | LOW | Fix ID generation. Any corrupted requests will have timed out and can be retried. |
| Cancel semantics (11) | MEDIUM | If process was killed prematurely, workspace may have partial file changes. User can use git to recover. |

---

## Sources

### Codebase Analysis
- `src/backend/domains/session/claude/process.ts` -- Process lifecycle, detached spawn, process group kill pattern
- `src/backend/domains/session/claude/protocol.ts` -- NDJSON protocol handler, backpressure handling, request/response correlation
- `src/backend/domains/session/claude/permission-coordinator.ts` -- Current binary permission model
- `src/backend/domains/session/claude/permissions.ts` -- Permission modes, auto-approve logic, DeferredHandler
- `src/backend/domains/session/runtime/claude-runtime-manager.ts` -- Process-per-session management, creation locks
- `src/backend/domains/session/runtime/codex-app-server-manager.ts` -- Shared-process model, JSON-RPC transport
- `src/backend/domains/session/codex/codex-event-translator.ts` -- Event translation patterns (Codex -> FF)
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` -- Event forwarding, idle handling, interactive requests
- `src/backend/domains/session/store/session-process-exit.ts` -- Process exit cleanup and rehydration
- `src/backend/domains/session/providers/claude-session-provider-adapter.ts` -- Provider adapter pattern
- `src/shared/claude/protocol/websocket.ts` -- WebSocket message types and delta event shapes

### ACP Protocol
- [Agent Client Protocol - Overview](https://agentclientprotocol.com/protocol/overview) -- Core methods and lifecycle
- [Agent Client Protocol - Schema](https://agentclientprotocol.com/protocol/schema) -- Full method signatures, permission options, config options, mode categories
- [ACP TypeScript SDK - ClientSideConnection](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html) -- Unstable method signatures, capability API
- [ACP GitHub Repository](https://github.com/agentclientprotocol/agent-client-protocol) -- Protocol specification
- [Kiro ACP CLI Documentation](https://kiro.dev/docs/cli/acp/) -- Practical implementation guidance, session persistence, PATH caveats

### Node.js Process Lifecycle
- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html) -- Detached processes, process groups, stdio pipe behavior
- [MCP Lifecycle Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle) -- stdio shutdown sequence (SIGTERM -> SIGKILL pattern)
- [Killing process families with Node.js](https://medium.com/@almenon214/killing-processes-with-node-772ffdd19aad) -- Process group kill patterns

### ACP Community
- [Intro to Agent Client Protocol (ACP)](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/) -- Protocol design rationale
- [ACP Explained - CodeStandUp](https://codestandup.com/posts/2025/agent-client-protocol-acp-explained/) -- Permission option model
- [Cline ACP Implementation](https://deepwiki.com/cline/cline/12.5-agent-client-protocol-(acp)) -- Real-world ACP integration patterns

---
*Pitfalls research for: ACP-only provider runtime cutover*
*Researched: 2026-02-13*
