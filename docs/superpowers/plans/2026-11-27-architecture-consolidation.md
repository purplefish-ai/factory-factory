# Architecture consolidation program plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a short feature freeze, make the application safe at its edges
(restart, second process, real tools, the network, a user's install) and remove
the shipping surfaces that will not be kept.

**Architecture:** A fixed list of about 35 pull requests in three waves: stop
`main` going red; remove the desktop and Docker surfaces and build checks that
cross the real seams; then, with those checks required, fix state ownership.
Redesigns of the inside are listed as candidates, each with the evidence that
would start it, and are decided at the end of the freeze.

**Tech Stack:** TypeScript, Vitest, Playwright, the sandbox launcher under
`scripts/sandbox/`, Prisma/SQLite, Oxlint custom rules, GitHub Actions, `gh`.

**Spec:**
[docs/superpowers/specs/2026-11-27-architecture-consolidation-design.md](../specs/2026-11-27-architecture-consolidation-design.md).
"S1" below means invariant S1 in that document.

## How to read the tasks

Each task is one pull request unless it says otherwise. A task names its files,
what it produces and the checks that accept it; the implementer writes the
red-green steps.

Tasks marked **needs a step plan** depend on code that will have changed by the
time they start. Whoever starts one writes its step-level plan from the code as
it is then. The one task marked **design gate** starts with a short note that
Martin reads before any code is written.

## Baseline (2026-11-27, commit `08a2654b4`)

Each row is counted by the command or query in the last column; there is no new
script. "Test and script lines" is the sum, by `git ls-files` and `wc -l`, of
test, story and test-support files under `src/` (383,890), every script under
`scripts/` (25,828) and every file under `e2e/` (3,278).

| Measure                                                  | Baseline                | Target                                                          | Counted by                       |
| -------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- | -------------------------------- |
| Required checks that drive a workspace end to end        | 0                       | 1, both providers                                               | Branch protection                |
| Smoke scenarios / providers driven                       | 1 / Codex               | The 8 named in 2.3 and 2.4                                      | Scenario names in `e2e/sandbox/` |
| Kill-and-restart scenarios                               | 0                       | The 9 named in 2.2 and 2.5                                      | Same                             |
| `main` commits with no CI verdict, last 19               | 5 (cancelled)           | 0                                                               | `gh run list --branch main`      |
| Systems where the packed build drives a workspace        | 0                       | macOS and Linux, every PR                                       | `ci.yml`                         |
| Provider runtimes whose resolved version has a recording | 0 of 2                  | 2 of 2                                                          | Task 2.9's test                  |
| Backends that can own one data directory                 | Unbounded               | 1                                                               | Task 3.1's test                  |
| Accepted human prompts lost on restart                   | All queued              | None lost silently                                              | Task 3.4's scenarios             |
| npm versions with a tag and GitHub Release               | 0 of 21 since `v0.4.6`  | Every one from now                                              | `gh release list`                |
| Production lines under `src/`                            | 216,239                 | Reported; expected to rise by 3,000 to 4,000 (see D1)           | `pnpm metrics:agents`            |
| Test and script lines (see below)                        | About 413,000           | Reported; no higher at the gate than at wave 0 plus the harness | `git ls-files` and `wc -l`       |
| Patch releases per week                                  | About 4 (15 in 27 days) | Reported                                                        | `npm view factory-factory time`  |
| Files with a module-level service singleton              | About 110 singletons    | No new file                                                     | Task 6.1's exceptions file       |
| Files comparing against a provider literal, non-test     | 62 files, 126 sites     | No new file                                                     | Task 6.2's exceptions file       |

## Global Constraints

- **Feature freeze.** Until the wave 2 gate, only tasks in this plan, defect
  fixes and dependency updates merge. The freeze has the backstop date in D8.
- pnpm only, at the versions pinned in `.node-version` and `package.json`.
  Follow [verification](../../../CONTRIBUTING.md#verification) for every task.
- A task that changes behaviour adds the cheapest test that crosses the seam the
  change is about, and that test fails before the change. Where a smoke or
  kill-and-restart scenario can express it, it is one.
- The orchestrator rebases and merges one pull request at a time when two touch
  any of these: `prisma/schema.prisma` and `prisma/generated/`,
  `src/backend/app-context.ts`, `src/test-utils/application-graph.ts`,
  `src/backend/server.ts`, `.github/workflows/ci.yml`, `package.json`,
  `.oxlintrc.json`, `lint-rules/factory.mjs`, the two baseline files under
  `scripts/`, and the sandbox launcher. Schema changes are never open two at a
  time.
- Migrations are additive. No enum value is removed while a row may hold it. A
  migration that drops a removed feature's tables is not part of the freeze.
- Three releases are cut: the wave 1 opening release, the wave 1 exit and the
  wave 2 gate. A hotfix between them branches from the last release tag.
- The agents doing this work run inside Martin's daily install. A gate is driven
  in the sandbox, never on the live data directory.
- Markdown wraps at 80 columns (`pnpm exec oxfmt --write <file>`). Open pull
  requests ready for review, one concern each.

## Review Focus

Failure modes these tasks' own tests would not exercise unless written down,
most likely first. Each is pinned by the test named in the owning task.

1. **The lock breaks a way of working that depends on sharing.** This
   repository's own Run script starts `pnpm dev` on the live database. Task 3.1
   owns the change to that script and the message a refused `pnpm dev` prints.
2. **The first update across the lock boundary.** The CLI from the previous
   release stays in memory and starts the new backend, so nothing hands it a
   lock. Task 3.1 owns "an update from the last published release, and its
   rollback, complete".
3. **A stale lock strands the user.** After a power loss the lock names a dead
   process or a reused process id. Task 3.1 owns the takeover tests and the
   override named in the refusal message.
4. **A copied database stops someone else's agents.** A backup or a sandbox
   seeded from real rows carries recorded process groups. Task 3.3 records the
   owning server and stops only its own.
5. **A durable prompt is delivered twice, or starts an agent nobody is
   watching.** Task 3.4 owns the uncertain state and the rule that nothing is
   resent on ambiguous evidence.
6. **An old browser tab meets a new server.** Task 4.1 ships the version
   handshake in the opening release, before removals change the wire.
7. **The fakes drift from the real tools.** Task 2.9 keys recordings on the
   runtime version the adapter resolves and fails when that version has none.
8. **An upgrade meets rows the new code does not expect.** Task 2.6 boots a
   database seeded with every enum value on the current build.

## Decisions (Martin, 2026-11-27)

| ID  | Decision                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No feature is removed. Host metrics is in daily use, and event automations are wanted and will be used more. Port sharing, voice, Slack, the logical export and the rest all stay. |
| D2  | The desktop app is dropped: removed from the README, the workflows and the build.                                                                                                  |
| D3  | The Docker image is dropped.                                                                                                                                                       |
| D4  | Subagents merge on green with no outstanding comments, as before. The merge queue is turned on.                                                                                    |
| D5  | `pnpm dev` refuses a data directory another backend holds. This repository's Run script uses `pnpm dev:sandbox`, so its preview shows a seeded project with the fake provider.     |
| D6  | Upstream recordings are made on Martin's machine by an agent using his sign-ins. Output is scrubbed and committed to this public repository.                                       |
| D7  | The npm package supports macOS and Linux, and the README says so.                                                                                                                  |
| D8  | The freeze has a backstop 14 days after wave 0 ends. Tasks still open then become issues.                                                                                          |
| D9  | Implementers and reviewers run on Opus or Sonnet, in parallel where the Order table allows.                                                                                        |

**What D1 means for Z1.** The freeze work adds an estimated 3,000 to 4,000
production lines under `src/`, and nothing under `src/` is removed, so
production source ends larger, not smaller. Dropping the desktop app removes
about 1,700 lines, all outside `src/`. The spec's Z1 is restated to match: the
freeze reports the figure and adds nothing beyond its own tasks.

## Order

| Wave | Tasks                                                                                                                                                                                                     | Exit                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0    | 0.1, 0.2, 0.3                                                                                                                                                                                             | `main` green; merge queue on with today's four checks      |
| 1    | Opening: 4.1, 5.1, 5.2, 5.3, 2.6, then a release. Removal lane, serial: 1.1 → 1.3 → 6.1 → 6.2. Harness lane, serial: 2.1 → 2.2 → 2.3 → 2.4 → 2.5. Beside them: 2.9a first, then 2.9b; 2.7, 2.10, 3.5, 6.3 | 2.8: smoke required. G1 note read. Release                 |
| 2    | 3.1 → 5.4 → 3.3 → 3.4 → 3.2; 4.2 beside them                                                                                                                                                              | Martin drives the gate script. Release. Candidates decided |

The longest serial chain is 2.1 → 2.2 → 2.3 (two pull requests) → 2.4 → 2.5 →
2.8 → 3.1 → 5.4 → 3.3 → 3.4 → 3.2. If the backstop date nears, 3.2 is the task
that becomes an issue; 3.1, 3.3 and 3.4 finish.

The program waits on Martin five times: the G1 note, the three releases, and the
wave 2 gate.

---

## Workstream 0: Stop the line

### Task 0.1: Make `main` green

**Files:** `scripts/check-packed-serve.mjs`,
`src/backend/routers/websocket/setup-terminal.handler.ts`.

`main` fails "Minimum Node runtime (24.0.0)" with
`Setup terminal: {"type":"exit","exitCode":0}`. The check fails when `exit`
arrives before `packed-ready` has been seen, and the handler forwards PTY output
and exit with no drain. The same job passed one commit earlier.

- [ ] A test reproduces the ordering deterministically.
- [ ] The pull request says whether the handler should send buffered output
      before `exit`, and fixes whichever side is wrong.

### Task 0.2: Every commit on `main` gets a verdict

**Files:** `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`,
`scripts/ci-workflow.test.ts` (it pinned `cancel-in-progress: true`).

- [ ] Runs for pushes to `main` are not cancelled by later pushes.

### Task 0.3: Merge queue (after D4)

**Files:** branch protection for `main`, changed by Martin or with his say-so.

Wave 1 is the widest wave, so the queue comes before it. A known case: a removal
that deletes a singleton and a pull request that adds an exception for it are
each green and together turn `main` red, because a stale exception fails
`lint-rules/exceptions.test.ts`.

- [ ] The task first confirms that the Socket check reports on
      `gh-readonly-queue/*` commits. If it does not, Socket leaves the required
      checks or the queue is not turned on.
- [ ] The queue requires today's four checks. Task 2.8 adds the smoke aggregate.

---

## Workstream 1: Remove (Z4)

### Task 1.1: Remove the desktop app and the Docker image (D2, D3)

**Files:** `electron/`, `electron-builder.yml`,
`.github/workflows/electron-release.yml`, `Dockerfile`, `docker-compose.yml`,
`docker-entrypoint.sh`, `nginx.conf`, the Docker workflows, `README.md`,
`pnpm-workspace.yaml`, the `dev:electron` script.

- [ ] Both surfaces are removed with their workflows, scripts, dependencies and
      README text. The README says the package supports macOS and Linux (D7).
- [ ] A build constraint goes only if nothing else needs it. The SQLite driver
      override also keeps one driver for file locks; the pull request says what
      it found.
- [ ] `src/backend/electron-utility-entry.ts`, `electron-utility-backend.ts`,
      `tsconfig.electron.json` and the Electron branches in `scripts/` go with
      them. `pnpm knip` and `pnpm check:unused-code` find nothing left behind.
- [ ] The pull request states the lines it removed.

### Task 1.3: Retire checks another mechanism already covers (needs a step plan)

**Files:** the 22 `scripts/check-*` files, the `check` script in `package.json`.

CI logs cannot say what each check has caught: `pnpm check` is one `&&` chain,
so a log shows only the first failure, and agents run it before pushing.

- [ ] A table of each check's run time and size.
- [ ] A check is deleted, with its tests and baseline, when the violations in
      its own test fixtures are already rejected by the type checker, a lint
      rule, knip or another check. The pull request shows that for each one
      deleted.
- [ ] If none qualifies, the task closes with the table.

---

## Workstream 2: Checks that cross the real seams (V1–V5, X2)

### Task 2.1: A fake Codex with history, and one spec per scenario

**Files:** `src/backend/testing/fixtures/fake-codex-app-server.mjs`; split
`e2e/sandbox-smoke.spec.ts` into `e2e/sandbox/<scenario>.spec.ts`;
`playwright.sandbox.config.ts`; `scripts/sandbox/prepare.mjs` (the seed
repository holds only a README; scenarios need a setup script and a run script).

Today the fake has one thread id for every process, keeps no turns, writes no
rollout file, and takes one scenario per sandbox.

**Produces:** a fake that picks its scenario from the prompt text, issues a
thread id per thread, writes rollout files, and has a stream that waits for a
release signal. Rollout line shapes start from those already inline in the
`codex-session-history-loader` tests, so this task does not wait, and are
replaced by task 2.9a's Codex recording when it lands.

- [ ] The existing echo scenario passes from its own spec file.
- [ ] A loader test reads a rollout file the fake wrote and yields the turn. The
      browser-level check that history survives is in task 2.2, after a restart,
      because a reload alone replays the store the server kept in memory.

### Task 2.2: Restart mode for the sandbox

**Files:** `scripts/sandbox/launch.mjs`; create `e2e/support/backend-process.ts`
and a crash-point module outside any `testing/` directory.

Today the launcher treats a server exit as the end of the sandbox and deletes
its data directory, and the backend runs under `tsx watch`.

**Produces:** a launcher mode that starts the backend directly, keeps Vite and
the data directory across backend exits, and rebinds the same port;
`killBackend(signal)` and `restartBackend()`; and `crashAt(name)`, a call in
server code that exits the process when the sandbox has armed that name, read
through `configService`. Each crash point is declared where it is called. The
mode exercises the development backend, not the supervised production `serve`;
task 2.7 covers the packed build.

- [ ] Scenario: finish a turn, kill the server, restart; the browser reconnects
      without a reload and shows the same transcript, now read from the rollout
      file.
- [ ] Scenario: kill the server; "Reconnecting…" appears within ten seconds, and
      the board and chat recover after restart with no reload (task 4.1).
- [ ] Scenario: `SIGSTOP` the server, so the socket stays open and silent; the
      same banner appears (task 4.1).
- [ ] A scenario that arms a crash point no code declares fails.

### Task 2.3: Smoke scenarios

**Files:** `e2e/sandbox/`. Two pull requests.

- [ ] Each is driven through the browser on one shared sandbox: permission
      approve; permission deny; stop mid-stream; reload mid-stream (using the
      gated stream) and see the same transcript; a second session and a switch
      back; archive; delete.
- [ ] The smoke job stays under four minutes. It takes 63 to 103 seconds today.

### Task 2.4: A Claude turn through the released adapter

**Files:** Create a fake Claude executable under
`src/backend/testing/fixtures/`; the sandbox launcher.

The adapter and the application both honour `CLAUDE_CODE_EXECUTABLE`. The fake
must speak what the SDK and the CLI exchange on standard input and output,
permission requests included; task 2.9 records that exchange.

- [ ] One smoke scenario runs a prompt turn and a permission prompt on a Claude
      session through `@agentclientprotocol/claude-agent-acp` as shipped.

### Task 2.5: Characterise restart recovery

**Files:** `e2e/sandbox/restart-*.spec.ts`. No production change beyond crash
points.

- [ ] One kill-and-restart scenario for each of: a session mid-turn; a workspace
      mid-provisioning with its setup script alive; a run script; a terminal; an
      archive in flight; a prompt queued behind a running turn.
- [ ] Each scenario asserts what happens today. Where that is a loss or a stuck
      state, the assertion is marked as a known gap with an issue number, and
      the issue is the output.
- [ ] After `SIGKILL`, the scenario lists which child processes of the dead
      server are still alive.

### Task 2.6: Upgrade check from the last release

**Files:** Create, as text, a SQL seed with at least one row in every table and
every enum value in use; a test in the Build job. `*.db` files are ignored by
git, and tables filled only from GitHub or Slack get no rows through the app.

- [ ] The test applies the migrations shipped in the last published package,
      loads the seed, then migrates and boots the current build on that
      database; the board loads.
- [ ] When a release is cut, the migration list the test starts from is updated
      by a script from the published package.

### Task 2.7: The packed build drives a workspace, on macOS too (D7)

**Files:** `scripts/check-packed-consumer.sh`, `scripts/check-packed-serve.mjs`,
`.github/workflows/ci.yml`.

Today the packed check stops at health, the index page and the setup terminal,
and runs on Ubuntu only in pull request CI. It runs from the checkout, so it can
copy the fake provider in and point `CODEX_PATH` at it.

- [ ] The packed check creates a workspace and runs one fake-provider turn.
- [ ] It runs on `macos-latest` and Ubuntu for every pull request. The
      repository is public, so the runner is free. The browser smoke stays on
      Ubuntu.

### Task 2.8: Make the smoke test required

**Files:** `.github/workflows/ci.yml`; branch protection.

The workflow's bar is 50 consecutive green runs, earned so far by one echo
scenario: of the last 70 runs on `main`, 52 were green, 15 cancelled and none
failed.

- [ ] The bar is 20 consecutive completed runs of the smoke job on `main`,
      counted from the merge of task 2.5. Runs dispatched by hand on the head of
      `main` count, so the bar measures flakiness and does not wait for merges.
      Cancelled runs do not count either way.
- [ ] A "Smoke" aggregate job, like `Build` and `Test`, joins the required
      checks and the merge queue.
- [ ] Wave 2 does not start before this.

### Task 2.9: Recorded upstream contracts (after D6; two pull requests)

**Files:** Create `src/backend/testing/fixtures/upstream/<tool>/<version>/` and
`scripts/record-upstream.mjs`; `package.json`; `.github/dependabot.yml`.

**Produces:** for one real session per provider: the prompts sent, the ACP
update stream, what the SDK and the CLI exchanged on standard input and output
(captured by a wrapper named in `CLAUDE_CODE_EXECUTABLE`), the history file the
CLI wrote, and the app-server responses the backend reads. Paths, account names
and tokens are scrubbed; the repository is public.

**2.9a**, at the start of wave 1: the recorder and the raw recordings. Tasks 2.1
and 2.4 take their line shapes from them.

- [ ] The recorded sessions are synthetic: scripted prompts written for the
      purpose, run in a throwaway repository created for the recording, never in
      a real project. A pattern scrub cannot make a real transcript safe to
      publish.
- [ ] The recorder writes only an allowlist of fields per record type and
      replaces every other value with a placeholder of the same type.
- [ ] A test fails if a recording contains a home directory path, an account
      name, an email address or a token pattern.
- [ ] Pushing a branch publishes it. The recordings are read in full by the
      orchestrator in the implementer's worktree before the first push, and
      again whenever they are re-recorded.

**2.9b**, beside the lane:

- [ ] The history loaders and the update translator parse every recording.
- [ ] **Equivalence (X2):** for each recorded session, the transcript built from
      the live stream equals the transcript reloaded from the history file.
      Known differences are listed in the test, each with a reason.
- [ ] `@agentclientprotocol/claude-agent-acp` is pinned exactly; it is `^0.99.1`
      today, so a user's install can resolve an adapter CI never saw.
- [ ] A test fails when a runtime version resolved the way
      `scripts/prepare-runtime-metadata.mjs` resolves it, or an adapter version,
      has no recording directory.
- [ ] Dependabot ignores the adapter and runtime packages; it cannot run the
      recorder. A bump is a pull request that includes the new recording.

### Task 2.10: `gh` output parsed from real recordings

**Files:** Create `src/backend/testing/fixtures/upstream/gh/`; extend
`scripts/record-upstream.mjs`.

`gh` is not pinned, so the recording notes the version it came from and nothing
gates on it.

- [ ] Each read-only call shape in `src/backend/services/github/` is recorded
      against public objects of this repository: a merged pull request, an open
      one, an issue, labels, review requests. `api user` and `auth status` are
      recorded and scrubbed.
- [ ] Every Zod schema that reads `gh` output parses the recording of its call.
      Shapes with no recording are listed in the test.

---

## Workstream 3: State has one owner and survives a restart (S1–S3, S6)

Wave 2, in the order of the Order table.

### Task 3.1: One backend per data directory (after D5, needs a step plan)

**Files:** Create `src/backend/lib/data-directory-lock.ts`; delete
`src/backend/lib/file-lock-mutex.ts`, which has no importer. Callers:
`src/cli/index.ts` (the serve, supervised and update-recovery paths),
`src/cli/proxy.ts`, `src/cli/tailscale.ts`,
`src/cli/supervised-serve-session.ts`, `src/backend/index.ts`,
`factory-factory.json`, `scripts/sandbox/`, `CONTRIBUTING.md`.

**Produces:** a lock on the database path and the worktree base directory,
recording a random id for this acquisition, the holder's process id and start
time and, once the backend is up, the backend's process id and URL. The
outermost process takes it and hands it to its children. A backend that was
handed none takes it itself, which covers `pnpm dev:backend`, the sandbox's
restart mode, and a backend started by a CLI from before this release.

- [ ] A second backend on the same directory exits non-zero and prints the URL
      of the first, the sandbox command, and the name of an override variable.
      The first backend's sessions are untouched.
- [ ] `pnpm dev` obeys the lock. This repository's Run script starts
      `pnpm dev:sandbox`. For that to work the sandbox gains: the port file
      written in the workspace, where the post-run step waits (today it lands in
      the sandbox's temporary directory); an option that passes
      `DISABLE_CORS_CHECKS` through its environment allowlist; no time limit
      (the default is 120 minutes); and its detached server stopped when the
      launcher is killed outright.
- [ ] A lock is taken over only when both the holder and the backend it recorded
      are dead, or are live processes with different start times. If only the
      CLI was killed, its backend still holds the directory.
- [ ] An in-app update and a rolled-back update complete with the lock held, and
      update recovery copies the database back only while holding it.
- [ ] An update from the last published release, and its rollback, complete.

### Task 3.2: Delete is resumable

**Files:** `prisma/schema.prisma` (a nullable `deletionStartedAt` on
`Workspace`, not a new status value); `scripts/check-single-writer.mjs` (the
field needs an owner); move the sequence from
`src/backend/trpc/workspace.trpc.ts` into
`src/backend/orchestration/workspace-lifecycle/`.

Worktree removal is an atomic rename into the trash, and a failed rename falls
back to deleting in place
(`docs/decisions/2026-11-25-worktree-removal-detaches-then-reclaims.md`).

- [ ] The marker is set before removal starts. The task names every read that
      must hide a marked row: the board and list reads, and the job queries
      (`findAllNonArchivedWithSessionsAndProject`, `findNeedingWorktree`). There
      is no single query owner; workspace reads are spread over 19 files.
- [ ] When removal succeeds, the row is deleted. When it fails with the
      directory still intact, the marker is cleared and the caller told. When it
      fails part-way, the marker stays and removal is retried until it succeeds
      and the row is deleted.
- [ ] Archive recovery skips a marked row; an archiving row's `updatedAt` is its
      lease.
- [ ] A marked row found at startup is finished. Task 2.5's crash point after
      the rename now ends with the workspace gone.

### Task 3.3: Agent processes are owned

**Files:** `src/backend/services/session/service/acp/acp-client-factory.ts`,
`acp-runtime-spawn.ts`, `agent-session.accessor.ts`,
`docs/architecture/agent-runtime.md` (it says persisted process ids are never
signalled).

- [ ] Every runtime starts in its own process group, as event-owned sessions do
      today. The group id, its start time and the acquisition id of the lock
      that started it are recorded, and cleared on exit. Start time is read the
      way `worktree-process-sweep.ts` reads it.
- [ ] At startup, under the lock, a recorded group is stopped only if its start
      time still matches and its owner is the current acquisition or the one
      this lock was taken over from. The taker reads the old acquisition id
      before overwriting the file. Then the session row is reset.
- [ ] `ff backup`, `ff restore` and anything else that copies a database clear
      those columns.
- [ ] Task 2.5's scenario now finds no agent process of the dead server alive.
- [ ] The guide states the new rule. Setup scripts, run scripts and tunnels are
      not changed here; task 2.5's list of survivors becomes an issue.

### Task 3.4: Accepted prompts are durable (design gate G1, needs a step plan)

**Files:** `prisma/schema.prisma`, the session store and queue,
`queue-message.handler.ts`, `steer-queued-message.handler.ts`,
`workspace-init.orchestrator.ts`, `session-domain.service.ts`.

The G1 note, written in wave 1, decides:

- which of the four existing durable forms this reuses;
- what proves a human prompt was delivered, given that PR delivery proves it
  with a marker line inside the prompt text and a human prompt has none;
- whether a prompt restored at startup is sent or only shown. If it is only
  shown, this task does not depend on task 3.3 and can move ahead of it;
- what creates a session store at startup, since stores are created lazily
  today;
- how cancelling, editing and steering a queued message change its row;
- the order of restored prompts against PR events, which restart from their own
  ledger, and what happens at the queue size limit;
- where attachment bytes live, since the image store is in memory;
- what happens to queued settings and the published-initial-message guard.

Acceptance, whatever the note decides:

- [ ] A prompt queued behind a running turn is in the queue after a restart, or
      is shown in the transcript as not sent. It is never absent.
- [ ] A workspace created with an initial prompt and killed before dispatch does
      not end up ready, idle and empty.
- [ ] A prompt whose delivery is uncertain is not sent again.
- [ ] Restore happens at startup, not when a browser opens the session.
- [ ] "Retry setup" no longer resends a delivered first prompt.

### Task 3.5: Report session state combinations

**Files:**
`src/backend/services/session/service/store/session-runtime-machine.ts` and its
`markRuntime` call sites.

Wave 1, so it gathers data during wave 2. The setter accepts any combination of
phase, process state and activity today.

- [ ] The combinations the call sites can produce are read from the code and
      written as a table. Each is marked meaningful, or produced today but
      meaningless (for example, running with no process).
- [ ] A meaningless or unlisted combination is logged with the caller.
      Transitions between combinations are counted, not judged: any state can
      precede any writer, so a transition table would fail on timing.
- [ ] The sandbox prints the counts in a job that is not required. Nothing is
      rejected, and no required check depends on it.
- [ ] The counts from the smoke runs and from Martin's install are read at the
      wave 2 gate.

---

## Workstream 4: The network (P2, P3)

### Task 4.1: A lost connection is visible and always retried

**Files:** `src/hooks/use-websocket-transport.ts`,
`src/client/hooks/use-project-snapshot-sync.ts`, the chat transport, the
snapshot and chat WebSocket handlers, one banner in the app shell.

Part of the opening release, tested at the transport. Its two browser scenarios
are checkboxes of task 2.2.

- [ ] The transport never stops retrying; the delay is capped.
- [ ] The client sends an application-level ping and reconnects when no reply
      arrives.
- [ ] The handshake carries the package version, the only identifier client and
      server share. A tab older than the server shows "Reload to update".
      Development builds between releases are not protected.
- [ ] A hidden tab, whose timers the browser throttles, does not reconnect in a
      loop or report a healthy connection as lost.

### Task 4.2: Completion events reach every tab

**Files:** `chat-event-forwarder.service.ts`, `snapshots.handler.ts`,
`WorkspaceNotificationManager.tsx`.

Completion notices are broadcast to every chat socket, across projects. A tab
with no chat socket gets none. `/snapshots` is open on every page but is scoped
to the selected project.

- [ ] Completion and attention events are sent to every snapshot connection,
      whatever project it selected, as well as to chat connections.
- [ ] Each event carries an id. A tab holding both sockets plays the chime once.
- [ ] A tab on the board plays the chime for a workspace in another project, as
      a chat tab does today.

---

## Workstream 5: Releases (R1, R3)

### Task 5.1: Every version is tagged and released

**Files:** `.github/workflows/npm-publish.yml`, `scripts/verify-npm-release.sh`,
`README.md`.

Publishing is `npm stage publish` followed by a human approval on npm, which is
why tagging is a second manual dispatch, and why it has never completed.

- [ ] A scheduled job finds published versions with no tag, and creates the tag
      and the GitHub Release for each. The commit comes from the version's
      provenance attestation on the npm registry; published versions carry no
      `gitHead`.
- [ ] The pull request reports whether a staged, provenance-signed publish can
      target a dist-tag other than `latest`. A canary is a candidate, not part
      of this task.

### Task 5.2: A failed backup stops the migration

**Files:** `src/backend/migrate-with-backup.ts`,
`src/cli/supervised-serve-session.ts`.

- [ ] A failed pre-migration backup stops the migration and says why (a full
      disk, a read-only directory). An environment variable proceeds without
      one, so every entry point can use it.
- [ ] The supervised update, which takes its own snapshot first, sets that
      variable for its `db:migrate`.

### Task 5.3: `ff backup`

**Files:** `src/cli/`, `src/backend/lib/sqlite-snapshot.ts`.

- [ ] `ff backup` takes a physical snapshot of the database, with
      `{baseDir}/encryption.key` and `{baseDir}/codex-accounts/`. It is safe
      while a backend runs.

### Task 5.4: `ff restore` (after 3.1)

**Files:** `src/cli/`.

The downgrade guard makes each migration one-way; this is the way back. It
merges before task 3.3, the first schema change of wave 2, and ships with it.
Before the lock there is no reliable way to tell that a backend is running: the
running-server marker is written only by a production `serve` on an
auto-updating global install.

- [ ] `ff restore <backup>` takes the data-directory lock, or refuses and names
      the holder.
- [ ] It replaces the database, removes the `-wal`, `-shm` and `-journal` files
      as the supervised update does, and restores the key and account
      directories.

---

## Workstream 6: Stop the growth

After the removal lane, so the exceptions files are written once.

### Task 6.1: No new module-level service singleton

**Files:** Create `lint-rules/rules/no-service-singleton.mjs` with its test and
exceptions file.

Exceptions are keyed by file path in this repository's lint infrastructure.

- [ ] `export const x = new X()` under `src/backend/**` outside tests is
      rejected in any file not excepted. Today's files are the exceptions, and
      the stale-exception test removes a file when its last singleton goes.

### Task 6.2: No new provider comparison

**Files:** Create `lint-rules/rules/no-provider-literal-branch.mjs` with its
test and exceptions file.

- [ ] A comparison against `'CLAUDE'` or `'CODEX'` outside
      `src/backend/services/session/service/providers/` is rejected in any file
      not excepted. Today's 62 files are the exceptions. A new comparison inside
      an excepted file still passes; that limit is stated in the rule's
      description.

### Task 6.3: Two import sites for the SDK

**Files:** Create a types-only module in `src/shared/acp-protocol/` and a values
module in `src/backend/services/session/service/acp/`; an import rule.

`/unstable` is the only SDK entrypoint in use, in 36 non-test files under
`src/`, and it supplies runtime values such as `ndJsonStream`.

- [ ] Symbols the stable entrypoint offers are imported from it.
- [ ] Everything else comes through the two modules, in tests too. Structural;
      no behaviour change.

---

## Candidates, decided at the wave 2 gate

None of these starts during the freeze. At the gate each gets a recorded
decision: start, wait for the trigger below, or drop.

| Candidate                                         | Trigger                                                                      | Known before starting                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One session state record (S5)                     | Task 3.5 reports a meaningless combination, or a stuck-status defect         | The record needs one lifetime: store state dies on eviction, supervisor maps live with the process                                                     |
| One recovery registry (S4)                        | Three or more of task 2.5's gaps are still open at the gate                  | Resources need a before-ready or after-ready phase; process-backed rows are verified and stopped first; the CLI update journal stays outside           |
| Revisions on the workspace stream (P1)            | A defect traced to the reconciler, or a React Query upgrade that breaks it   | Only `listForProject` can be served from the store; it needs a per-project epoch and revision, removals included; entries hydrate before first publish |
| Chat resume cursor                                | The freeze ends; it is the session-resume feature                            | `order` is a transcript position, not a sequence; only duplicate-frame guards can be deleted                                                           |
| A provider interface (X1)                         | A third provider is wanted                                                   | A third of the comparisons are spawn, sign-in, slash-command, label and shared-code cases a first design missed                                        |
| One wiring style and one lifecycle list (Z2, Z3)  | Decided at the gate from how often wave 1 and 2 collided on `app-context.ts` | Dispatch and lifecycle form a real cycle and need a lazy parameter; more bridges exist than the 14 in one file                                         |
| `gh` driven through the browser                   | A PR-monitoring defect the recordings did not catch                          | Needs ordered recordings and a workspace linked to a fixture pull request                                                                              |
| Stop idle agent processes                         | Task 2.9's equivalence test is green                                         | It sends more traffic through resume; background shells and subagents count as activity                                                                |
| Behaviour tests in place of interaction tests     | Test lines at the gate are higher than at wave 0 plus the harness            | 346,000 test lines and 1,525 `vi.mock` calls; no capsule has a `testing/index.ts` yet                                                                  |
| Installed dependency graph equals the tested one  | An install defect caused by dependency resolution                            | `docs/npm-package-security.md` already rejects a lockfile translator without clean-install tests                                                       |
| Canary releases                                   | Task 5.1's report says a staged publish can target another dist-tag          | Publishing needs a human approval on npm                                                                                                               |
| `ff doctor`; routes compose; one shared-code home | Decided at the gate                                                          | `components.json` pins `@/lib` and `@/hooks`, so the move needs a home for design-system utilities first                                               |
| Workspace mail carries a typed source             | Decided at the gate                                                          | The event-automation path bypasses the queue on purpose and stays                                                                                      |

## Done

The freeze ends at the wave 2 gate, or on the D8 date if that comes first.

- Every task above is merged, or is an issue with a reason.
- The smoke test is required and the wave 2 release is cut.
- Martin has driven the gate script in the sandbox.
- Each candidate has a recorded decision.
- The pull request that records those decisions deletes this plan and its spec,
  moves anything still true into the subsystem guides, and deletes
  `docs/superpowers/plans/2026-11-13-agent-friendly-codebase.md`, whose
  unstarted tasks 4.3, 5.2 and 5.3 are candidates here.
