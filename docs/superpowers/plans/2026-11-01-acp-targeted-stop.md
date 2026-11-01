# Targeted ACP Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan.

**Goal:** Stop one supported live ACP process or subagent from its existing UI.

**Architecture:** The ACP tracker retains live control identities and exposes
capabilities through shared state. A validated session mutation resolves the
current runtime and sends the provider stop. Existing provider events reconcile
completion; React adds icon controls to the two existing lists.

**Tech Stack:** TypeScript, React, tRPC, Zod, ACP SDK, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-11-01-acp-targeted-stop-design.md`

## Global Constraints

- Follow root, backend-service, and client-feature AGENTS.md and
  CONTRIBUTING.md.
- Node 26.12.1 and pnpm pinned in package.json; no npm/yarn.
- Always-visible filled-square controls with accessible tooltip labels
  `Stop process` and `Stop subagent`; pending disabled spinner.
- Unsupported, historical, completed, disconnected and stale items lack
  controls.
- Server validates live capability and ownership; no implicit runtime startup.
- Parent and unrelated siblings must remain unaffected.
- Preserve read-only review and capsule boundaries; use Zod at boundaries.

## Review Focus

- Old UI requests must not stop a replacement task/runtime or child generation.
- Replayed active states do not grant live cancellation capabilities.
- Pending state must settle on completion, disconnect, failure, or timeout.
- A task may finish between render, click, response, and provider notification.
- Stop must not also select the subagent row or cancel the root prompt.

### Task 1: Implement targeted stopping end to end

**Files:**

- Modify shared task/subagent schemas in `src/shared/session-runtime.ts` and
  `src/shared/acp-protocol/subagents.ts` and consumers that validate these
  states.
- Modify
  `src/backend/services/session/service/acp/acp-native-session-tracker.ts` and
  add focused control helpers/tests beside it if file limits require it.
- Add the stop method to the session runtime/service public API and tRPC session
  router following existing listSubagents/readSubagentTranscript wiring.
- Modify `src/client/features/chat/session-activity-indicator.tsx`, its parent
  wiring, and `src/client/features/subagents/subagent-list.tsx` and section.
- Add co-located backend/client regression tests and Storybook states.
- Update `docs/architecture/agent-runtime.md`.

**Interfaces:**

- Consume live provider task `canStop` and native child cancel capabilities.
- Produce a shared validated control reference containing enough identity to
  fence stale runtime/generation requests. Choose names consistent with code.
- Produce a session-scoped stop mutation with a discriminated task/subagent
  target. It rejects unsupported or stale identities before provider dispatch.

- [ ] Write failing focused tests for valid task/child targeting, rejection of
      historical/unsupported/stale identities, and parent/sibling preservation.
- [ ] Run focused tests and capture the expected failures.
- [ ] Retain capabilities and identities, implement validated dispatch through
      the current handle, and propagate capabilities through state/snapshots.
- [ ] Add UI tests for visible/hidden controls, distinct row selection, pending,
      errors, and disconnect/completion; implement icon-only controls and
      wiring.
- [ ] Run focused tests to green, update stories and architecture documentation.
- [ ] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, applicable
      integration tests, Storybook verification, and `pnpm check`; inspect
      unrelated edits.
- [ ] Self-review and commit the completed implementation with issue reference.

## Execution ruling

The user explicitly approved the design and requested implementation with a
subagent and a PR. Proceed without an additional plan-approval pause. One agent
owns this cohesive cross-layer task to avoid competing interface edits.
