# Workspace Mail Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development. Execute the approved design without
> another confirmation; native subagents only, no child workspaces.

**Goal:** Replace automatic workspace message injection with a durable,
selectively retrieved inbox and coalesced body-free notifications.

**Architecture:** Extend workspace-owned notification persistence with bounded
mail APIs and a durable revision/wake latch. Session integration delivers only
mail signals and preserves assignment-first startup. MCP and UI consume the same
recipient-scoped service operations.

**Tech Stack:** Node 26.12.1, pnpm 12.15.0, TypeScript, Prisma/SQLite, tRPC,
React.

**Spec:** ../specs/2026-11-02-workspace-mail-inbox-design.md

## Global Constraints

- Native subagents only, never child workspaces; shared current isolated branch.
- Disjoint file ownership; no worker commits or repository-wide formatting while
  others edit. Root integrates and commits the coherent result.
- No live DB writes. Disposable BASE_DIR/DATABASE_PATH for runtime tests.
- Co-located meaningful regression tests before implementation; no full-suite
  worker runs. Root owns the one full verification run.
- Capsule boundaries, Zod validation, configService and existing permission
  fences.

## Review Focus

- Concurrent arrival during acknowledgement cannot lose new mail or wake state.
- Restart/full queue recovery must not re-inject bodies or repeat old signals.
- Recipient-scoped IDs cannot read or acknowledge another workspace's mail.
- Long reports remain retrievable within a total response budget.
- Explicit initial assignment cannot be displaced by recovered mail.

### Task 1: Durable mail persistence and shared API (native persistence worker)

Own shared/workspace-mail.ts, Prisma schema/migration/generated output,
registry, workspace notification accessor/service and their co-located tests.

- [x] Write and run regressions for bounded list/read, scoped acknowledgement,
      progress supersession, revision ordering and concurrent wake-latch
      transitions.
- [x] Implement shared contract and additive legacy-safe migration.
- [x] Generate Prisma and run focused service/real-SQLite migration tests.
- [x] Record API, files and verification in the task report.

### Task 2: Runtime mail signals and startup ordering (native runtime worker)

Own session notification/startup integration, workspace notification delivery
orchestrator/children persistence metadata, prompt builder and related tests.
Consumes Task 1 facade and shared schemas; coordinates exact wake port directly.

- [x] Write and run regressions for assignment-first startup, one signal per
      burst, no raw bodies, queued failure recovery, supported native steering
      and safe fallback with existing ownership fences.
- [x] Replace automatic body injection with bounded durable wake signals.
- [x] Recover wakes on startup and queue/turn progress, without a polling storm.
- [x] Run affected focused tests and record evidence in the task report.

### Task 3: Visible workspace inbox (native UI worker)

Own new workspace inbox components/hooks/stories/tests and workspace right-panel
composition only. Consumes workspace.listMail/readMail/ackMail tRPC operations.

- [x] Write and run meaningful component tests for bounded summaries, selected
      body reads, acknowledgement, error states and pagination.
- [x] Implement inbox navigation, unread state and deliberate retrieval.
- [x] Add representative Storybook states and run focused UI checks.
- [x] Record files and evidence in the task report.

### Task 4: MCP/tRPC boundaries, integration and delivery (root)

Own workspace children tRPC router/tests, workspace MCP server/tests, schema
validation at the tool boundary, integration wiring outside worker ownership,
docs and final verification.

- [x] Add bounded recipient-scoped list_mail/read_mail/ack_mail tools to both
      parent and child workspace MCP contexts; extend send metadata and truthful
      ACK.
- [x] Add tRPC inbox procedures sharing Task 1 schemas; trigger pending wake
      recovery after acknowledgement through Task 2 owner.
- [x] Verify integration, startup, legacy migration and tool contracts.
- [ ] Run check:fix, typecheck, full tests, applicable integration tests, check,
      schema/generated checks and Storybook. Keep unrelated formatting out.
- [ ] Run one whole-change independent review and Cubic; fix validated findings
      in one consolidated wave, then scoped verification/review.
- [ ] Commit and open the ready-for-review PR per repository conventions.
