# Workspace lifecycle orchestration

Coordination across capsules from a workspace's launch to its archive:
interactive launch, initialization and its retries, accepted renames, generated
names and conversation summaries, child workspaces, archive and recovery. The
[services guide](../../services/AGENTS.md) covers the capsules this code
coordinates. Bare file names below are in this directory; paths that start with
`src/` are from the repository root.

## Owns, and does not own

This directory owns the order of those steps and the in-process queues around
them: per-workspace rename serialization, the metadata inference queue and its
throttle, and the initialization sequence from worktree to the first agent
session. It does not own:

- Creation validation, persistence, worktrees, the snapshot store and the
  metadata rows: `src/backend/services/workspace/`.
- The setup, startup and run-script processes:
  `src/backend/services/run-script/`.
- Session creation, the session message queue and metadata inference
  (`generateWorkspaceMetadata`): `src/backend/services/session/`.
- The metadata prompt and its input bounds:
  `src/backend/prompts/workspace-metadata.ts`.
- Snapshot events and periodic snapshot reconciliation:
  `src/backend/orchestration/snapshots/`.

## Public surface

There is no barrel. `src/backend/app-context.ts` composes launch, rename,
metadata, initialization, archive, children, follow-up, notification and retry
modules; `src/backend/orchestration/domain-bridges.orchestrator.ts` wires
initialization, launch, deletion capture and reconciliation;
`src/backend/orchestration/agents/` uses initialization, and the snapshot
collector is given `fireLifecycleNotification` (typed from
`workspace-children.orchestrator.ts`) for PR-opened notices to a parent.

## Invariants

- An interactive launch that resolves a provider (session capacity above zero,
  or an explicit model, account, access mode or reasoning effort) does so before
  it persists the workspace. `workspace-launch.orchestrator.test.ts`.
- For interactive and child launches, a failure to create the default session
  keeps the new workspace and still starts its initialization; a periodic-task
  launch keeps the workspace but fails without initializing it.
  `workspace-launch.orchestrator.test.ts`.
- Initialization persists READY, with or without a setup warning, before it
  starts the default agent session. `workspace-init-startup-order.test.ts`.
- Renames of one workspace are serialized within an application, each published
  before the next starts, and never wait on another workspace's rename.
  `workspace-rename.orchestrator.test.ts`.
- Metadata results ask to rename only a MANUAL workspace whose generated-name
  marker equals its current name. `workspace-metadata.orchestrator.test.ts`.
- Metadata inference runs at most once per workspace per two minutes, and a
  result superseded by newer conversation activity is never accepted.
  `workspace-metadata.orchestrator.test.ts`.

## Map

- `workspace-launch.orchestrator.ts`: source policy for interactive, child and
  periodic-task launches.
- `workspace-init.orchestrator.ts`: worktree, then setup and startup phases
  (`workspace-init-script-pipeline.ts`) while the initial prompt is prepared
  (`workspace-init-issue-prompts.ts`) and queued, READY, then the default agent
  session; `workspace-init-cleanup.ts` handles failures.
- `workspace-retry-authority.ts`: whether and how a failed or warned workspace
  may retry setup.
- `workspace-rename.orchestrator.ts`: accepted renames and their snapshot
  publication.
- `workspace-metadata.orchestrator.ts`: the process-local metadata queue, a
  `jobRunner` job, enabled by `WORKSPACE_METADATA_ENABLED`.
- `workspace-follow-up.orchestrator.ts`: human follow-ups dismiss completed PRs.
- `workspace-children.orchestrator.ts`,
  `workspace-notification-delivery.orchestrator.ts`,
  `workspace-notification-persistence.orchestrator.ts`: child workspaces and
  notifications between parent and child.
- `workspace-archive.orchestrator.ts`, `workspace-deletion.orchestrator.ts`:
  archive, stale-archive recovery and deletion capture.
- `reconciliation.service.ts`: startup and periodic recovery of workspaces that
  still need a worktree and of orphaned terminal sessions, and the archived-blob
  retention job.

## Decisions

- [Setup finishes before the agent starts](../../../../docs/decisions/2026-11-13-setup-finishes-before-the-agent-starts.md)
