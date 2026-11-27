# Architecture consolidation: target state

This is the design the
[consolidation plan](../plans/2026-11-27-architecture-consolidation.md)
implements. It states what "healthy" means as invariants, gives the 2026-11-27
evidence that each does not hold yet, and says which ones the plan delivers
during the feature freeze and which it leaves for later. Evidence was measured
at commit `08a2654b4`. Items marked _(reported)_ come from a reviewer's reading
and were not rechecked; a task that depends on one verifies it first.

## The finding in one paragraph

The inside of the codebase is disciplined: 3 `as unknown as` casts and 3 uses of
`any` in about 216,000 production lines under `src/`, and one import that
reaches past a capsule barrel. The weaknesses are at the edges, where the
application meets something it does not control: a restart, a second process, a
real `gh`, a real agent CLI, a user's machine, a flaky network. At each edge the
real thing is either faked in the checks or not handled. Production source grew
from 134,000 to 225,000 lines in twelve weeks, so the gaps grew with it.

The plan follows from that: fix the edges and remove what will not be kept,
during a short freeze. Redesigns of the inside are not started on the review's
say-so. Each waits for evidence that the freeze work is built to produce.

## Invariants the freeze delivers

### V: checks cross the real seams

- **V1.** A required check drives the real application (real composition root,
  migrated SQLite, real git worktree, real browser, a scripted provider) through
  the core loop for both providers.
- **V2.** For each agent CLI, CI parses output recorded from the real tool at
  the version the bundled adapter resolves, and a change to that version cannot
  merge until the recording is refreshed from the real tool. For `gh`, which is
  not pinned, CI parses output recorded from the real tool, with its version
  noted.
- **V3.** Every commit on `main` gets a CI verdict, and two green pull requests
  cannot make `main` red.
- **V4.** Restart behaviour is tested by killing the real server process.
- **V5.** The packed build is launched, and drives a workspace, on every
  operating system the package claims. A surface with no such check is not
  offered to users.

Evidence: required checks are Build, Test, Lint and Socket, with no required
review and no up-to-date requirement; the sandbox smoke test is the only
browser-to-agent test, covers one Codex scenario and is not required; the
real-provider tests are gated by variables that appear in no workflow; every
`ci.yml` job runs on Ubuntu; the sandbox `gh` shim exits 1 for every call; runs
on `main` cancel each other, so 5 of the last 19 commits have no verdict; about
47% of assertions in orchestration tests are call assertions on mocks.

### S: state has one owner and survives a restart

- **S1.** At most one backend owns a data directory at a time.
- **S2.** A prompt the user was told was accepted is never silently lost. After
  a restart it is delivered, or shown as not sent.
- **S3.** A workspace delete records that it is in flight before its first
  irreversible step, and something finishes it after a crash.
- **S6.** Agent processes are owned: started in their own process group,
  recorded with the server that started them, and ended when that server is
  gone. A copy of a database owns no processes.

Evidence: the prompt queue is an in-process array
(`src/backend/services/session/service/store/session-queue.ts`). Nothing locks
the data directory, startup sets every `RUNNING` session to `IDLE`, and sharing
the database between a production server and `pnpm dev` in a worktree is the
documented setup (`CONTRIBUTING.md`, "Database"). Workspace delete stops
runtimes, removes the worktree and deletes the row with no intermediate state
(`src/backend/trpc/workspace.trpc.ts`). `providerProcessPid` has no live writer,
and only event-owned sessions get their own process group.

### P: the network

- **P2.** A lost or half-open connection is always visible to the user and
  always retried, and a browser tab older than the server is told to reload.
- **P3.** An event that concerns the whole application reaches every open tab,
  whatever page and project it shows.

Evidence: the transport stops after 10 reconnect attempts and only the terminals
show it (`src/hooks/use-websocket-transport.ts`); the server pings only at
WebSocket protocol level and the client has no liveness check; no client version
check exists; completion notifications are broadcast to chat connections only,
and the one socket every page opens, `/snapshots`, is scoped to the selected
project.

### X: upstream tools

- **X2.** The live projection of a transcript and the reloaded one are proven
  equal on sessions recorded from the real tools.

Evidence: reopened sessions are rebuilt from `~/.claude/projects/*.jsonl` and
Codex rollout files, a second path beside the live ACP stream; six recent fixes
concern replay divergence (#3326, #2774, #2724, #2682, #2656, #2607).

### R: releases

- **R1.** Every published version has a tag and a GitHub Release.
- **R3.** A migration does not run when its backup failed, and a user can take
  and restore a complete backup.

Evidence: zero GitHub Releases, last tag `v0.4.6`, npm at 0.5.14; the job that
tags and releases is a second manual dispatch that has never completed;
`migrate-with-backup.ts` warns and migrates when the backup fails; the downgrade
guard makes each migration one-way for a user with no restore command.

### Z: no larger than it must be

- **Z1.** The freeze adds no production source beyond its own tasks, and the
  figure is reported at the gate with test and script lines beside it. Martin
  decided on 2026-11-27 that every feature stays, so production source under
  `src/` ends the freeze an estimated 3,000 to 4,000 lines larger.
- **Z4.** A shipping surface nobody will keep is removed: the desktop app and
  the Docker image go.

Evidence: 15 npm versions in 27 days; the desktop app has not shipped since
April and the Docker image is a month stale _(reported)_; event automations own
13 of 38 tables and about 20,900 production lines.

## Invariants left for after the freeze

Each is real, and each has a reason to wait. The plan's Candidates section gives
the evidence that would start it.

- **S4, one recovery mechanism.** About twelve mechanisms exist, each with its
  own staleness test. Two recorded decisions shape them (slow recovery runs
  after readiness; a provisioning row is left alone while its setup script is
  alive), and the newest was merged on 2026-11-25. The freeze characterises them
  with restart scenarios before anyone rewrites them.
- **S5, one session state record.** Status is re-derived on each read from
  several maps and flags, and the "machine" accepts any combination.
  Stuck-status defects exist but are older. The freeze reports which
  combinations of state occur; that report decides.
- **P1, revisions on every stream.** The client reconciles HTTP with the
  snapshot stream in 690 lines that hook React Query internals. It is a month
  old and has had no fix. The server's `version` is a per-entry in-memory
  counter that restarts at zero, not a revision a client can compare, so this is
  a design, not a cleanup.
- **X1, a provider interface.** There are 126 comparisons against provider
  literals and no interface. A third provider is not planned. The freeze stops
  the count growing.
- **X3, one import site for the unstable SDK.** `/unstable` is the only SDK
  entrypoint in use, in 36 files under `src/`. The freeze narrows it to two
  modules.
- **Z2 and Z3, one wiring style and one lifecycle declaration.** About 110
  module-level singletons, late-bound bridges and three hand-kept lists. No
  defect in history traces to them; the cost is churn in `app-context.ts`. The
  freeze stops new singletons.
- **R2, a canary before `latest`.** Depends on whether `npm dist-tag` promotion
  works with staged, provenance-signed publishing.
- **The test suite's mass.** About 346,000 test lines under `src/` and 1,525
  `vi.mock` calls. Replacing interaction tests with behaviour tests is the right
  direction and too large for the freeze.

## Design decisions that hold across tasks

- **Delete before fixing.** The desktop and Docker removal comes first, so later
  tasks do not repair code that is about to go.
- **The harness gates merges before the risky changes start.** The smoke test
  becomes a required check at the end of wave 1. Wave 2 does not start before
  that.
- **Characterise before changing.** Restart recovery and session state are first
  recorded as they behave today. Gaps become issues; they are not fixed in the
  same pull request.
- **The outermost process owns the data directory.** Migrations run in the CLI
  parent, not the backend, and an in-app update runs three processes under one
  logical owner. The lock is taken by the outermost process and handed to its
  children. A backend started with no parent, or by a parent from a release that
  predates the lock, takes it itself.
- **Nothing shares a live data directory, development included.** `pnpm dev`
  obeys the lock like any other backend. Development against real-looking data
  uses the sandbox, which seeds its own directory. A copy of the live database
  is not a safe seed: its rows hold absolute worktree paths, and its jobs would
  poll GitHub a second time.
- **Single ownership simplifies recovery for rows, not for processes.** Once S1
  holds, a row left in flight by a dead server is orphaned. A child process may
  still be alive, so anything process-backed is verified by process group, start
  time and owning server, and stopped before its row is recovered.
- **Ambiguous evidence never authorises a resend.** This is the existing rule
  for PR delivery, and durable prompts keep it: a prompt whose delivery is
  uncertain is shown to the user, not sent again.
- **Four durable prompt forms already exist** (PR delivery, workspace mail,
  `AgentInitialDelivery`, `creationMetadata.initialPrompt`). Durable human
  prompts reuse one; they do not add a fifth.
- **Wire and schema changes follow the version handshake.** Wave 1 opens with a
  small release that carries the handshake, the fail-closed backup and
  `ff backup`. Every later change to what the browser receives comes after it.
- **The version that matters is the one the adapter resolves.** Following the
  recorded decision on provider runtimes, recordings are keyed on the runtime
  versions `scripts/prepare-runtime-metadata.mjs` resolves, not on dependency
  ranges.

## Not in this program

A third provider; ACP v2; an application-owned transcript store; reshaping the
wire model away from Claude's stream format; telemetry; changing the 1,000-line
cap; the cloud design under `docs/design/`; the session resume cursor, which is
a feature and resumes after the freeze.
