# Upstream Codex ACP migration implementation plan

> **For agentic workers:** Use test-driven development and independent task
> ownership; review the combined change before creating the pull request.

**Goal:** Replace the internal Codex adapter with released upstream ACP and use
provider-native permissions consistently for Claude and Codex.

**Architecture:** Factory Factory owns client interaction, workspace lifecycle,
and persistence. Upstream adapters own the Codex/Claude harness and permissions.
The ACP client translates native subagent, elicitation, and planning contracts
into existing application views. No local Codex adapter or blanket permission
auto-approval remains.

**Tech stack:** TypeScript, ACP SDK 1.7, codex-acp 2.2.2, Claude ACP 0.88,
Vitest.

**Spec:** The compatibility spike and user-approved migration in this task.

## Constraints and decisions

- Preserve existing provider histories; normalize legacy `sess_` IDs at the
  transport boundary without replacing durable identities or using fallback.
- Convert legacy Codex configuration snapshots before strict PR resume.
- Separate native access modes from collaboration/planning. Retain saved
  STRICT/RELAXED/YOLO defaults only as backward-compatible preset inputs.
- Reviewer sessions retain read-only access and reject all escalation.
- No writes to the user's native Codex configuration or credentials.
- Preserve provider subagent browsing and background activity for both adapters.
- Open a ready-for-review PR, never a draft.

## Tasks

1. [x] Normalize permissions/configuration and plan approval for both providers.
       Own lifecycle configuration, snapshot migration, chat controls and
       related tests. Use upstream Codex `mode` for access and
       `collaboration_mode` for plan; Claude uses native `mode`. Remove the
       extra Codex approval turn.
2. [x] Implement native subagent/session activity tracking and browsing. Own a
       transport-side tracker, process handle/browser, and related tests. Expose
       tracker callbacks for factory/handler integration; do not forward child
       transcript chunks into the parent conversation.
3. [x] Switch package/spawn, normalize provider IDs, bridge elicitation and plan
       permission requests, retain lightweight catalog discovery, delete the old
       adapter and obsolete build/schema plumbing, update packaging and docs.
4. [x] Run focused tests and required repository checks, review integration and
       migration regressions. Deliver through a ready-for-review PR.

## Shared interfaces

- Task 1 preserves public session configuration APIs and supplies snapshot
  conversion through the existing snapshot parser/PR resume path.
- Task 2 adds `AcpNativeSessionTracker` with capability negotiation, raw-message
  interception, native list/read projections, and activity callbacks. Task 3
  constructs it before the SDK connection and stores it on the process handle.
- Task 3 normalizes upstream plan-review permission requests to the existing
  `ExitPlanMode` application interaction, preserving original option IDs.
- Task 3 bridges form/URL elicitation into existing pending-request interaction
  and validates user responses before returning them to the adapter.

## Review focus

- Existing `sess_` conversations and exact saved PR configuration resume without
  creating a replacement conversation.
- Approving a plan starts implementation once; access presets never approve a
  plan or answer a question automatically.
- Read-only reviewers cannot escape their access mode, including via
  elicitation.
- Child transcript and permission session identities route to the owning parent.
- Source CLI, installed CLI and Electron resolve a compatible packaged runtime.

## Verification

- Add focused regression tests before behavior changes; run affected tests.
- Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check`.
- Inspect final diff, run an independent code review, and resolve material
  issues.
- Do not perform live inference or modify user credentials to verify packaging.

## Execution evidence

- Required formatting/lint fixes, typecheck, repository guards, and unused
  dependency checks pass. The full suite passes 6,466 tests; one manual suite
  remains skipped.
- Production build and Electron TypeScript compilation pass. Built
  `ff codex --version` resolves the bundled native Codex 0.160.1 runtime.
- A contract test exercises the published ACP adapter against a synthetic
  app-server, covering native access, image forwarding and legacy resume without
  inference or native configuration writes.
- Independent review findings were verified and fixed: native custom choice
  answers and explicit message presentation for zero-field consent forms.
- Live model/authentication flows and a packaged desktop launch were not run.
