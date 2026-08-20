# ACP Runtime Manager Modularization Design

## Context

The file-length ratchet currently records
`src/backend/services/session/service/acp/acp-runtime-manager.ts` at 1,449 lines
and its primary test at 2,705 lines. The manager combines public facade methods,
cross-session runtime state, process startup, ACP negotiation, sub-agent
browsing, prompt execution, live configuration, stop coordination, and shutdown.

The preceding session-lifecycle modularization established an important
boundary: lifecycle coordinators own domain policy and durable reconciliation,
while the ACP runtime layer owns subprocess handles, pending creation,
incarnation filtering, and quiescence. This refactor preserves that boundary
while giving the runtime layer one explicit mutable authority and several
focused, stateless collaborators.

The work will be delivered as a staged pull-request series. Every stage must be
independently green and preserve the public `AcpRuntimeManager` contract.

## Goals

- Keep `AcpRuntimeManager` as the stable public ACP runtime entry point while
  reducing it to a compatibility facade below roughly 600 lines.
- Make `AcpRuntimeSupervisor` the sole owner of cross-session mutable runtime
  state and lifecycle coordination.
- Separate process creation, prompt execution, live configuration, and
  sub-agent browsing into focused units with narrow interfaces.
- Split the 2,705-line manager test by responsibility without weakening its
  assertions or relying on private-member access.
- Remove both original manager entries from the file-length baseline.
- Preserve public method signatures, event shapes, callback ordering, error
  behavior, logs relied on by tests, and observable ACP behavior.

## Non-Goals

- Changing provider behavior, ACP protocol messages, or public session APIs.
- Moving domain lifecycle policy or durable status reconciliation into the ACP
  runtime layer.
- Publishing the new internal collaborators through the session or ACP barrel.
- Replacing the ACP SDK, process transport, or Codex adapter.
- Generalizing the design into a provider framework beyond the needs of the
  current Claude and Codex runtimes.
- Fixing unrelated defects. A concurrency defect exposed by an ownership
  extraction may be fixed only when the new boundary cannot otherwise preserve
  a required invariant; such a fix requires a focused regression test and an
  explicit pull-request note.

## Architecture

`AcpRuntimeManager` remains the only public entry point. It constructs and
delegates to an internal graph:

```text
Callers
  `- AcpRuntimeManager facade
       |- AcpRuntimeSupervisor        <- sole mutable runtime authority
       |    `- AcpClientFactory       <- spawn, handshake, create/resume
       |- AcpPromptController         <- prompt, cancel, timeout escalation
       |- AcpRuntimeConfigController  <- live ACP mode/model/config calls
       `- AcpSubagentBrowser          <- validated provider extensions
```

The manager retains its existing constructor and public methods. Callers in app
context, lifecycle coordinators, routers, chat handlers, and voice handlers do
not receive or import the internal collaborators. The singleton remains
exported from the existing ACP and session barrels.

During Stages 2 through 4, the existing manager temporarily supplies the
handle lookup, current-incarnation checks, stop callback, and startup
cancellation signals required by the extracted stateless units. Stage 5 moves
those exact narrow ports to the supervisor without changing the collaborators'
interfaces. The client factory's candidate is temporarily installed by the
manager until the supervisor assumes that responsibility in the ownership
cutover.

### AcpRuntimeSupervisor

The supervisor is the only unit that owns cross-session mutable runtime state:

- installed process handles;
- pending creation promises and per-session creation serialization;
- active versus browse-only purpose;
- incarnation metadata and installed state;
- managed-stop classification and exit fences;
- stop operations, stop cancellation waiters, and shutdown admission state;
- creation-operation barriers and quiescence.

It owns creation admission, installation and removal, exit classification,
stop, shutdown, and runtime status queries. Only the supervisor may add or
remove a handle from the installed registry or decide whether a child belongs
to the current incarnation.

Protocol-local fields remain on `AcpProcessHandle`. A stateless controller may
update `isPromptInFlight` or `configOptions` on the handle supplied for one
operation, but it may not retain that handle or change registry membership.

### AcpClientFactory

The client factory is stateless across sessions. It receives explicit runtime
options, event handlers, environment configuration, startup timeout, and
supervisor-owned cancellation signals. It:

- resolves and spawns the adapter process;
- builds normalized ACP streams and the client-side connection;
- performs the ACP initialize handshake;
- loads a stored provider session or creates a new one;
- validates required configuration options; and
- terminates a child when startup fails or is cancelled.

It returns an uninstalled runtime candidate. The supervisor rechecks stop and
shutdown state, installs the candidate synchronously, wires steady-state exit
ownership, and publishes the existing creation callbacks. A failed or cancelled
factory operation never mutates the installed registry.

### AcpPromptController

The prompt controller receives the current handle and a narrow supervisor port
for current-incarnation checks and stopping. It owns:

- prompt dispatch and `isPromptInFlight` transitions;
- explicit prompt cancellation;
- caller-specified prompt deadlines;
- graceful cancellation followed by stop escalation; and
- stale-handle protection after a timeout.

It does not kill children or remove handles directly. Timeout escalation calls
the supervisor-owned stop operation only when the timed-out handle is still the
installed incarnation.

### AcpRuntimeConfigController

The runtime configuration controller performs live ACP configuration calls and
updates the supplied handle's configuration cache. It owns generic config
options, session modes, and provider-specific model behavior, including the
existing Claude fallback from `unstable_setSessionModel` to the generic model
option. Persistence and client delta publication remain in
`SessionConfigService`.

### AcpSubagentBrowser

The browser validates list and transcript parameters, checks provider
capabilities on the supplied browse handle, invokes the ACP extension methods,
validates responses, and normalizes provider errors into the existing browse
error codes and messages. It retains no session or handle state.

## Runtime Flows

### Creation

```text
manager request
  -> supervisor rejects shutdown, same-session stop, or exit-handler reentry
  -> supervisor serializes work for the session
  -> supervisor waits for prior exit handling
  -> supervisor returns/promotes an existing or pending runtime when possible
  -> factory creates an uninstalled runtime candidate
  -> supervisor rechecks stop and shutdown state
  -> supervisor installs the candidate and records its purpose/incarnation
  -> supervisor wires exit ownership and publishes creation callbacks
```

The supervisor continues to expose the creation-operation barrier used by
session startup. That barrier spans the entire caller operation through durable
`RUNNING` reconciliation, not only process spawning.

### Exit

The child exit callback enters the supervisor. The supervisor classifies the
child as current or stale and managed or unexpected. It removes only the
current installed handle, establishes the per-session exit fence, and dispatches
the existing typed runtime-exit event. Replacement creation waits for that fence
before installing another runtime. A stale child cannot affect the replacement.

### Stop and quiescence

`stopClient` remains idempotent through one tracked stop promise per session.
The supervisor signals in-progress startup, waits for pending creation with the
existing soft bound, cancels an in-flight prompt when possible, sends SIGTERM,
and escalates to SIGKILL after the existing grace period. Registry removal is
incarnation-safe.

`stopAndQuiesce` preserves the two-pass rule: stop the current runtime, wait for
all creation barriers that existed at admission time, then stop again if a
barrier could have installed a runtime. A failure from the first stop remains
observable when no barrier requires a second pass.

### Prompt execution

The manager obtains the current active handle from the supervisor and delegates
the call to the prompt controller. The controller holds that handle only for
the duration of the call. If a timeout fires after replacement, the controller
recognizes that its handle is stale and does not cancel or stop the replacement.

### Shutdown

Shutdown first closes supervisor admission and rejects all startup cancellation
waiters. It stops current runtimes, waits for pending factory operations and all
creation barriers, and performs the existing final stop sweep. It then clears
the supervisor's registries and waiters. New creation remains rejected after
shutdown begins.

## Required Invariants

- At most one installed ACP runtime exists per Factory Factory session.
- Stop and shutdown win before and after every asynchronous startup boundary.
- Failed creation cleans up its child and never installs a partial handle.
- Stop and quiescence operations are idempotent for a session.
- Stale process errors and exits cannot mutate or report against a replacement
  incarnation.
- Browse-only runtimes stay hidden from active-session queries until promoted.
- Prompt timeout escalation can affect only the handle on which the prompt
  began.
- Shutdown rejects new creation, settles pending work, stops installed
  processes, and performs a final sweep.
- Runtime state has one writer: the supervisor.
- Lifecycle coordinators retain domain eligibility and durable reconciliation;
  the ACP runtime remains transport and process infrastructure.

## Error Handling

Existing public error classes and messages remain stable, including prompt
timeouts and unavailable browse sessions. Startup timeout, spawn error, stop
cancellation, and shutdown cancellation preserve their current observable
classification.

Extracted units return typed results or throw existing errors. They do not add
catch-and-continue behavior. Existing best-effort boundaries remain explicit:

- failed-start cleanup contains process-kill errors;
- prompt timeout escalation contains cleanup failures after the original
  timeout has been established;
- the provider-session-ID callback logs and continues on failure; and
- shutdown uses soft process-stop bounds before its final sweep.

Any behavior correction discovered during extraction must be the minimum needed
to restore a documented invariant, must demonstrate the old failure with a
regression test, and must be identified separately from the structural change.

## Staged Pull-Request Series

### Stage 1: Split and strengthen characterization tests

Split `acp-runtime-manager.test.ts` into responsibility-based public tests for
creation, browsing, termination, prompts, configuration, and status queries.
Add an explicit facade contract suite. Move existing assertions without
weakening them, consolidate shared process/connection fixtures in the existing
test-helper module, and eliminate private-member reach-through.

All resulting test files must remain below 1,000 lines. Remove the original
manager test from the file-length baseline when the split is complete.

### Stage 2: Extract sub-agent browsing

Create `acp-subagent-browser.ts` and its focused test. Move capability checks,
parameter and result validation, extension calls, error metadata extraction,
and browse error normalization behind a handle-per-call interface. Keep the
manager methods and router behavior unchanged.

### Stage 3: Extract prompt and live configuration controllers

Create `acp-prompt-controller.ts` and
`acp-runtime-config-controller.ts` with focused tests. The manager supplies
current handles and narrow runtime-state callbacks during this transitional
stage; the supervisor backs the same ports after Stage 5. Preserve prompt
timeout and stale-handle semantics, config cache updates, and Claude model
fallback.

### Stage 4: Extract the ACP client factory

Create `acp-client-factory.ts` and its focused test. Move spawning, stream
construction, SDK connection setup, initialization, session load/new-session
negotiation, startup cancellation, and failed-start cleanup. The factory returns
an uninstalled candidate and holds no cross-session state. The manager
temporarily installs that candidate until installation ownership moves to the
supervisor in Stage 5.

Existing session-negotiation integration coverage continues to run against the
public manager.

### Stage 5: Establish the runtime supervisor

Create `acp-runtime-supervisor.ts` and split its tests between creation/exit and
termination/shutdown behavior. Move all shared mutable runtime state and the
creation, installation, exit, stop, and shutdown flows into the supervisor in
one ownership cutover. The manager continues to expose the same public methods.

This is the highest-risk stage and requires the full concurrency matrix before
merge: same-session concurrent creation, stop during startup, shutdown with
active/browse/pending work, replacement after exit, stale child events,
duplicate stops, failed initial stops, and bounded shutdown.

### Stage 6: Collapse and audit the facade

Reduce `AcpRuntimeManager` to construction and delegation, remove transitional
helpers, and verify that internal collaborators are absent from public barrels.
Update `docs/architecture/agent-runtime.md` to identify the supervisor as the
sole mutable runtime authority and the manager as its compatibility facade.

Audit for private test access, duplicate state, direct internal imports, stale
comments, and unintended public exports. Lower the file-length baseline after
the manager falls below the hard limit.

## Test Structure

The final focused suite is expected to include:

- `acp-runtime-manager.facade.test.ts` for the stable public contract;
- `acp-runtime-supervisor.creation.test.ts` for serialization, pending
  creation, promotion, installation, exits, fences, and incarnations;
- `acp-runtime-supervisor.termination.test.ts` for stop, quiescence, process
  escalation, shutdown admission, and final sweeps;
- `acp-client-factory.test.ts` for spawn configuration, streams, handshake,
  create/resume fallback, cancellation, and failed-start cleanup;
- `acp-prompt-controller.test.ts` for prompt state, explicit cancellation,
  deadlines, escalation, and replaced-handle protection;
- `acp-runtime-config-controller.test.ts` for generic options, mode/model
  behavior, cache updates, and provider fallback; and
- `acp-subagent-browser.test.ts` for capabilities, validation, extension calls,
  response schemas, and normalized errors.

Existing `acp-session-negotiation.integration.test.ts` and manual provider tests
remain in place. Manual tests are useful smoke checks when provider credentials
and binaries are available, but are not automated acceptance gates.

Every stage follows test-driven extraction: establish or move the failing or
characterizing assertion first, make the smallest ownership change, and run the
focused suite before repository-wide verification. Assertions may be relocated
or strengthened, never weakened solely to accommodate the new structure.

## Verification

Each pull request runs:

1. its focused ACP runtime tests;
2. `pnpm check:fix`;
3. `pnpm typecheck`;
4. `pnpm test`; and
5. `pnpm check`.

The stages that change session negotiation also run the affected integration
test set. The final stage verifies that `pnpm check:file-length` passes with the
two original manager entries removed.

## Acceptance Criteria

- `AcpRuntimeManager` is a stable compatibility facade below roughly 600 lines.
- `AcpRuntimeSupervisor` is the sole cross-session mutable runtime authority.
- Every new focused source and test file is below 1,000 lines and preferably
  below 600 lines.
- The original 1,449-line manager and 2,705-line manager-test entries are absent
  from `scripts/file-length-baseline.json`.
- No test accesses private manager state.
- Existing ACP and session barrel exports remain stable and contain no new
  internal collaborators.
- Public method signatures, error behavior, event shapes, callback ordering,
  runtime queries, and provider behavior are unchanged except for explicitly
  documented invariant-restoring fixes.
- The architecture guide documents the final ownership boundary.
- Focused tests, the full test suite, typecheck, and all repository guardrails
  pass at the end of every stage.
