# Agent-friendly codebase program plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nine
[agent-friendly codebase principles](../../architecture/agent-friendly-codebase.md)
true of this repository, measured against the 2026-11-13 baseline below.

**Architecture:** Eight workstreams, each a chain of small pull requests. The
order puts measurement and the instruction change first, then the work whose
files do not overlap in parallel, then the session split, which is serial.

**Tech Stack:** TypeScript, Node scripts under `scripts/`, Vitest, Playwright,
Oxlint custom rules, dependency-cruiser, GitHub Actions, `gh`.

**Spec:**
[docs/architecture/agent-friendly-codebase.md](../../architecture/agent-friendly-codebase.md).
"P3" below means principle 3 in that document.

## How to read the tasks

Each task is one pull request. A task names its files, the interface it produces
and the tests that accept it; the implementer writes the red-green steps.

Tasks marked **needs a step plan** depend on code that changes daily. Whoever
starts one writes its step-level plan from the code as it is then.

## Baseline (2026-11-13, commit `a571ce9fe`)

Measured by one-off commands; task 7.1 makes them reproducible.

| Measure                                                | Baseline                           | Target                               |
| ------------------------------------------------------ | ---------------------------------- | ------------------------------------ |
| Typecheck / `pnpm check` / full `pnpm test`            | 12s / 36s / 82s                    | Total stays under 3 minutes          |
| CI duration, median                                    | 7.1 min                            | No regression                        |
| PR branches green on first CI run (239 branches)       | 88%                                | No regression during the program     |
| Full local suite failures on clean `main`              | 1 in 1 run (passes alone)          | 0 in 5 consecutive runs              |
| Tokens of notes to read before an agent-runtime change | about 35,500                       | 4,000 or less for any one file (P1)  |
| `docs/architecture` growth over 300 commits            | +58% (source: +17%)                | Every note within its budget         |
| Most-edited file, share of last 300 commits            | 18% (`agent-runtime.md`, 55)       | 5% or less, manifests excepted (P7)  |
| Merged PRs with evidence from a running app            | Not recorded; none in two programs | Every PR with a user-visible change  |
| `session` capsule                                      | 500 files, 105,111 lines           | Modules with enforced surfaces (P2)  |
| `session` subdirectory pairs that import each other    | 11                                 | 0                                    |
| Capsule barrels using `export *`                       | 10 of 14                           | 0                                    |
| `vi.mock` calls / of capsule internals by path         | 1,367 / 139                        | Internals mocked across modules: 0   |
| Production files of 900 lines or more                  | 16                                 | Reported; no target (see task 3.6)   |
| Historical records in the tree                         | about 118,000 lines                | 0 on `main` (decision D1)            |
| Repository-owned skills, recipes, agent settings       | None                               | Five recipes, one settings file (P8) |

## Global Constraints

- pnpm only, at the versions pinned in `.node-version` and `package.json`.
- Follow [verification](../../../CONTRIBUTING.md#verification) for every task.
- New checks join the `check` script in `package.json`; no separate CI steps.
- No inline lint suppressions. Exceptions go in configuration with a reason and
  are covered by a test that fails once the exception is unnecessary.
- No `await import()` in `src/`. Read environment through `configService` in
  `src/`.
- Markdown wraps at 80 columns (`pnpm exec oxfmt --write <file>`).
- Open pull requests ready for review, one concern each. Required checks are
  Build, Test, Lint and Socket.
- A structural task changes no behaviour: its diff moves, renames or re-exports,
  and existing tests pass without edits to their assertions.
- No task adds a file that later tasks or feature work must edit on every pull
  request (P7).

## Review Focus

Failure modes these tasks' own tests do not exercise, most likely first. Each is
pinned by the test named in the owning task.

1. **The sandbox reaches something real**: `gh`, Slack, the update check, or a
   Claude session using the user's credentials. Task 1.1 owns the tests.
2. **A crashed sandbox leaves processes or worktrees behind.** Task 1.1 owns the
   cleanup and sweep tests.
3. **A note migration deletes a reason no test or record preserves.** Tasks 2.3
   to 2.7 require a disposition table in the PR body, and 2.3 is a review gate.
4. **The guide budget is met by moving prose into linked files**, the same
   effect as files settling under the line cap. Task 7.1 reports total guidance
   lines against source lines so the move is visible.
5. **Session moves collide with daily feature work in the same directories.**
   Tasks 3.3 to 3.5 are small, serial and merged the day they are opened.

## Decisions (Martin, 2026-11-13)

| ID  | Decision                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Tag `docs-archive-2026-11`, then delete historical plans, specs and milestone records from `main`. Active plans stay until completed. |
| D2  | Subagents open pull requests and merge them on green with no outstanding comments, using Opus or Sonnet as each task needs.           |
| D3  | Commit `.claude/settings.json`, limited to an allowlist of read-only and verification commands.                                       |
| D4  | Cursor Bugbot and Greptile are not used. Delete both configurations.                                                                  |
| D5  | cubic runs on its default configuration. Nothing to change.                                                                           |

Review gates that wait for Martin:

- **G1:** task 2.3, the first note migration, sets the standard for the other
  four.
- **G2:** task 3.2, the session module map, fixes the module list and order.

## Order

| Wave | Tasks                                            | Why this order                                                   |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------- |
| 0    | 0.1–0.5, 2.1, 7.1                                | Stop note growth and measure before changing anything            |
| 1    | 1.1–1.3, 2.2, 2.3, 3.1, 4.1, 4.2, 2.8 (after D1) | Disjoint files; run in parallel                                  |
| 2    | 2.4–2.7 in parallel; 5.1, then 3.2–3.5 in series | Notes are disjoint; session moves share files                    |
| 3    | 1.4, 6.1, 6.2, 4.3, 4.4, 5.2, 5.3, 7.2, 3.6      | Depend on the sandbox, the lint layout and the module boundaries |

---

## Workstream 0: Hygiene

### Task 0.1: Stop ignoring the committed Prisma client

**Files:** Modify `.gitignore` (remove the `prisma/generated/` entry and its
comment).

`prisma/generated/` has 45 tracked files and
[verification](../../../CONTRIBUTING.md#verification) says to commit it, but the
ignore rule makes `git add` skip any newly generated file.

- [ ] Remove the entry; confirm `git check-ignore prisma/generated/x` prints
      nothing.
- [ ] Run `pnpm db:generate && pnpm check:prisma-generated`; expect no drift.

### Task 0.2: Remove unused review and duplication configuration

**Files:** Delete `greptile.json`, `.jscpd.json` and `.cursor/BUGBOT.md`.

`greptile.json` describes `resource_accessors`, which no longer exist, and
neither Greptile nor Cursor Bugbot is in use (D4). `jscpd` is not a dependency
and no script runs it.

- [ ] Delete the files; `pnpm check` passes.

### Task 0.3: Clear the Knip configuration hints

**Files:** Modify `knip.json` (remove the three entries Knip reports as
redundant: `src/backend/index.ts!`, `src/cli/index.ts!`,
`src/client/main.tsx!`).

- [ ] `pnpm knip` prints no configuration hints and no new findings.

### Task 0.4: Fix the dependency-intake test that fails under load

**Files:** Modify `scripts/dependency-intake.test.ts` and whatever it exercises.

On a full `pnpm test` the case "rejects a two-day-old exact version until its
matching reviewed exception" failed at line 135 (`rejected.success` was `true`);
the file passes alone in 1.5s.

- [ ] Reproduce with the full suite; use superpowers:systematic-debugging to
      find the shared state or timing dependency.
- [ ] Fix the cause, not the assertion. Five consecutive full `pnpm test` runs
      pass.

### Task 0.5: Add the pull request template

**Files:** Create `.github/pull_request_template.md`; modify `CONTRIBUTING.md`
(pull request step 4).

Template sections, in order: **What changed**, **Why**, **Checks run**, **Driven
in the sandbox** (evidence, or the reason it does not apply), **Knowledge
updated** (tests / guide / decision record / none).

- [ ] `CONTRIBUTING.md` step 4 says bodies passed with `--body-file` follow the
      template.

---

## Workstream 1: Run and drive the real application (P6)

### Task 1.1: Isolated launcher

**Files:**

- Create: `scripts/dev-sandbox.mjs`, `scripts/dev-sandbox.test.ts`,
  `scripts/sandbox/gh-shim.mjs`
- Modify: `package.json` (`"dev:sandbox": "node scripts/dev-sandbox.mjs"`)

**Produces:**

- `pnpm dev:sandbox [--scenario <name>] [--keep]` starts
  `node src/cli/bootstrap.mjs serve --dev --no-open` on free ports and prints
  one line when ready: `SANDBOX_READY <absolute path to sandbox.json>`.
- `sandbox.json`:
  `{ baseDir, frontendUrl, backendUrl, pid, projectId, repoPath, scenario }`.
- `pnpm dev:sandbox --clean` removes every `ff-sandbox-*` directory under the OS
  temporary directory whose recorded `pid` is not running.

**Behaviour:**

- `BASE_DIR` is a new `ff-sandbox-*` directory from `mkdtemp` under
  `os.tmpdir()`; `WORKTREE_BASE_DIR` and `CODEX_HOME` are inside it. The
  database path derives from `BASE_DIR`.
- `CODEX_PATH` points at
  `src/backend/testing/fixtures/fake-codex-app-server.mjs`, the way
  `upstream-codex.integration.test.ts` already does.
- A directory holding `gh-shim.mjs` as `gh` is first on `PATH`. The shim appends
  its arguments to `<baseDir>/gh-calls.log` and exits 1 with
  `sandbox: gh is disabled`.
- Seeding uses public tRPC procedures after startup, never Prisma: one project
  on a new Git repository with one commit, default provider Codex.
- On `SIGINT`, `SIGTERM` or child exit it stops the server and deletes `baseDir`
  unless `--keep` was given.

**Acceptance tests** (`scripts/dev-sandbox.test.ts`):

- [ ] `refuses a BASE_DIR outside the OS temporary directory`
- [ ] `never opens the default database`: the default `~/factory-factory` path
      is not created or modified during a run with `HOME` set to a temporary
      directory.
- [ ] `prints SANDBOX_READY with a readable sandbox.json`
- [ ] `seeds one project on a fresh repository`
- [ ] `records gh calls instead of running them`
- [ ] `a Claude session cannot use the user's credentials`: with the sandbox
      environment, the resolved Claude configuration directory is inside
      `baseDir`. Try `CLAUDE_CONFIG_DIR` first; if the ACP adapter ignores it,
      the sandbox rejects Claude sessions with a message naming Codex.
- [ ] `removes baseDir and child processes on SIGTERM`
- [ ] `--clean removes only sandboxes whose pid is dead`

### Task 1.2: Scripted provider scenarios

**Files:** Modify `src/backend/testing/fixtures/fake-codex-app-server.mjs`;
create `src/backend/testing/fixtures/fake-codex-app-server.test.ts`.

**Produces:** the fake reads the scenario name passed by the launcher and plays
one of `echo` (default: replies with the prompt text), `tool-call`,
`permission-request`, `error` and `slow-stream`. Unknown names exit with the
list of valid ones.

- [ ] One test per scenario asserts the app-server messages emitted for a single
      prompt.
- [ ] `upstream-codex.integration.test.ts` passes unchanged.

### Task 1.3: Full-stack smoke test

**Files:** Create `playwright.sandbox.config.ts`, `e2e/sandbox-smoke.spec.ts`;
modify `package.json` (`test:e2e:sandbox`), `.github/workflows/ci.yml`,
`.github/scripts/select-ci.mjs`, `scripts/ci-workflow.test.ts`.

**Consumes:** `SANDBOX_READY` and `sandbox.json` from task 1.1; scenario `echo`
from task 1.2.

- [ ] The spec opens `frontendUrl`, finds the seeded project, creates a
      workspace, sends a message and sees the echoed reply.
- [ ] CI runs it as a non-required job. Promote it to required after 50
      consecutive green runs on `main`.

### Task 1.4: Make driving the app part of verification

**Files:** Modify `CONTRIBUTING.md` (verification table), create
`docs/recipes/verify-in-app.md` (see task 6.1 for the recipe format).

- [ ] The verification table gains a row: user-visible behaviour is driven in
      `pnpm dev:sandbox` and the evidence goes in the pull request body.
- [ ] The recipe gives the exact sequence: start, read `sandbox.json`, drive
      with the browser tool, save screenshots under the ignored `.context/`
      directory, stop.

---

## Workstream 2: One home for each kind of knowledge (P1, P4)

### Task 2.1: Change the instruction that grows the notes

**Files:** Modify `AGENTS.md`, `docs/architecture/README.md`, `CONTRIBUTING.md`,
`docs/superpowers/README.md`.

Do this first: about 30 pull requests a day follow these lines.

- [ ] `AGENTS.md`, replacing "Update docs when behavior changes": "A behaviour
      change is documented by its tests. Update the nearest guide only when
      ownership, an invariant, a public surface or the map changes; record a
      decision when a later reader could not infer the reason."
- [ ] `docs/architecture/README.md`, replacing the "Keep these current"
      paragraph: "Keep these true. Change a note when an invariant or a reason
      changes. Do not add a description of new behaviour; the regression test
      holds it."
- [ ] `CONTRIBUTING.md` pull request step 3 and `docs/superpowers/README.md`
      last paragraph say the same in their own context.

### Task 2.2: Guidance check

**Files:** Create `scripts/check-guidance.ts`, `scripts/check-guidance.test.ts`;
modify `package.json` (`check:guidance`, appended to `check`); fix
`docs/workspaces.md` (its two references to the removed ratchet service).

**Produces:** `pnpm check:guidance`, which fails with the file, the rule and the
fix for each of:

- **size:** an `AGENTS.md` over 120 lines; a `docs/architecture/*.md` or
  `docs/chat-message-flow.md` over 400 lines, unless listed in
  `legacyNoteCeilings` inside the script at its current line count. A ceiling
  may be lowered or removed, never raised or added.
- **pairing:** an `AGENTS.md` without a sibling `CLAUDE.md` containing exactly
  `@AGENTS.md`, or the reverse.
- **references:** a relative link or a backticked repository path that does not
  exist, in any `AGENTS.md`, `CONTRIBUTING.md`, `lint-rules/README.md`,
  `docs/README.md`, `docs/workspaces.md`, `docs/architecture/`, `docs/recipes/`
  or `docs/decisions/`.
- **records:** a file in `docs/decisions/` not named `YYYY-MM-DD-slug.md` or
  over 80 lines.

Initial `legacyNoteCeilings`: `agent-runtime.md` 2051, `integrations.md` 1505,
`workspace-state.md` 1092, `pull-requests.md` 736, `chat-message-flow.md` 565.

- [ ] One accepted and one rejected fixture per rule.
- [ ] `raising a legacy ceiling fails` and `adding a legacy ceiling fails`,
      comparing against the ceilings on the merge base.

### Task 2.3: Migrate the pull request note (review gate G1)

**Files:** Create `src/backend/orchestration/pull-requests/AGENTS.md` and
`CLAUDE.md`, records under `docs/decisions/`; modify or delete
`docs/architecture/pull-requests.md`; update links in `AGENTS.md`,
`docs/README.md`, `docs/architecture/README.md`; lower the ceiling in
`scripts/check-guidance.ts`.

Sort every paragraph of the 736-line note into one disposition:

| The paragraph states                        | It goes to                                              |
| ------------------------------------------- | ------------------------------------------------------- |
| Ownership, an invariant, where things are   | The area guide, with the test or check that enforces it |
| Why a design was chosen or rejected         | `docs/decisions/YYYY-MM-DD-slug.md`                     |
| Behaviour that a named test already asserts | Deleted                                                 |
| Behaviour no test asserts, worth keeping    | A new test, then deleted                                |
| Behaviour no test asserts, not worth a test | Deleted, listed in the PR body                          |

- [ ] The guide is 120 lines or fewer and `pnpm check:guidance` passes.
- [ ] The PR body has the disposition table: each removed paragraph's first
      words, its disposition, and the test or record path.
- [ ] Martin reviews before tasks 2.4 to 2.7 start.

### Tasks 2.4–2.7: Migrate the remaining notes

Same method and acceptance as task 2.3, one pull request per note, in parallel.

| Task | Note                                   | Guides created                                                                                                  |
| ---- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 2.4  | `docs/architecture/agent-runtime.md`   | `src/backend/services/session/`; module guides follow in workstream 3                                           |
| 2.5  | `docs/architecture/workspace-state.md` | `src/backend/services/workspace/`, `src/client/features/kanban/`                                                |
| 2.6  | `docs/architecture/integrations.md`    | `src/backend/services/agent-definition/`, `src/backend/services/github/`, `src/backend/services/periodic-task/` |
| 2.7  | `docs/chat-message-flow.md`            | `src/client/features/chat/`                                                                                     |

- [ ] After 2.7, `legacyNoteCeilings` is empty and the "Subsystem context"
      section of the root `AGENTS.md` tells agents to read the `AGENTS.md` in
      each directory they edit and its parents, naming no note.

### Task 2.8: Remove historical records from `main` (after D1)

**Files:** Delete `docs/superpowers/specs/`, completed files in
`docs/superpowers/plans/`, `docs/design/archive/`, `.planning/`,
`.superpowers/`, `.architecture/`, and the point-in-time `docs/design-*.md` and
`docs/workspace-notification-design*.md`; modify `docs/README.md`,
`docs/design/README.md`, `docs/superpowers/README.md`.

- [ ] Create and push the tag `docs-archive-2026-11` on the last commit that
      contains the records.
- [ ] `docs/README.md` "Historical work" becomes one paragraph naming the tag
      and `git show docs-archive-2026-11:<path>`.
- [ ] `docs/superpowers/README.md` says a plan is deleted by the pull request
      that completes it.
- [ ] `pnpm check` passes, including reference checks from task 2.2.

---

## Workstream 3: Session modules with enforced surfaces (P2)

Baseline: 18 subdirectories under `src/backend/services/session/service/`; 331
import edges between them; 11 pairs import each other. `acp` (123 files),
`archive` and `logging` import no sibling. Ten of the eleven mutual pairs
involve the nine files at the `service/` root.

### Task 3.1: Named exports in every capsule barrel

**Files:** Modify the ten `src/backend/services/*/index.ts` files that use
`export *`; merge each `service/index.ts` export list into them; modify
`.dependency-cruiser.cjs` or `lint-rules/` to reject `export *` in
`src/backend/services/*/index.ts`.

- [ ] Each capsule's public names are listed in its `index.ts` and nowhere else.
- [ ] A fixture with `export * from './service'` in a capsule barrel is
      rejected.
- [ ] No consumer import changes; `pnpm typecheck` and `pnpm deps:check` pass.

### Task 3.2: Session module map and check (review gate G2)

**Files:** Create `src/backend/services/session/modules.ts`; modify
`scripts/check-service-registry.ts`, `scripts/service-registry-dependencies.ts`
and its test.

**Produces:**

```ts
export const sessionModules: Record<
  string,
  { dependsOn: readonly string[]; description: string }
>;
/** Pairs that import each other today. May only shrink. */
export const sessionModuleCycles: readonly (readonly [string, string])[];
```

`pnpm check:service-registry` fails when the import graph between
`service/<module>/` directories differs from `sessionModules`, when a pair not
in `sessionModuleCycles` imports each other, or when a listed pair no longer
does.

- [ ] The first version records today's graph exactly, with the 11 pairs.
- [ ] The `service/` root is listed as module `root`, to be emptied by task 3.3.
- [ ] Martin reviews the module list and names before task 3.3.

### Task 3.3: Empty the `service/` root (needs a step plan)

**Files:** Move the nine non-test files at
`src/backend/services/session/service/*.ts` into the module each belongs to,
starting with `session-domain.service.ts` (876 lines).

- [ ] One pull request per file or cohesive pair; each removes at least one
      entry from `sessionModuleCycles` or one `root` dependency.
- [ ] Done when `root` is gone from `sessionModules`.

### Task 3.4: Module barrels, leaves first (needs a step plan)

**Files:** For each module, create `service/<module>/index.ts` with named
exports and route sibling imports through it; extend the check from task 3.2 to
reject a sibling import that bypasses a module's `index.ts` once that module is
marked `sealed: true` in `sessionModules`.

Order, by how many siblings each depends on today: `acp`, `archive`, `logging`,
then `inference`, `metadata`, `providers`, `voice`, then `delivery`,
`event-agent`, `store`, then `config`, `data`, `events`, `prompt`, then `chat`,
`dispatch`, `lifecycle`, `composition`.

- [ ] One pull request per module; each sets `sealed: true` for it.
- [ ] Each sealed module gets an `AGENTS.md` and `CLAUDE.md` of 120 lines or
      fewer, drawing on the session guide from task 2.4.

### Task 3.5: Remove the remaining mutual dependencies (needs a step plan)

- [ ] `chat` and `dispatch` stop importing each other; any pair left from task
      3.3 is resolved.
- [ ] `sessionModuleCycles` is empty and the check rejects a non-empty list.

### Task 3.6: Decide on `workspace`, `agent-definition` and the line cap

No code. After task 3.5, compare the metrics report (task 7.1) before and after
for `session`: first-run CI pass rate and pushes per PR for pull requests
touching it, and the count of production files at 900 lines or more.

- [ ] Record the result and the decision in `docs/decisions/`: whether to apply
      the module map to `workspace` (135 files) and `agent-definition` (130
      files), and whether the 1,000-line cap changes.

The cap stays at 1,000 until then. Lowering it now would produce more helper
files extracted to stay under a number, which is the effect being removed.

---

## Workstream 4: Remove collision points (P7)

Edits in the last 300 commits: `scripts/unused-code-baseline.json` 35,
`src/backend/app-context.ts` 18, `.oxlintrc.json` 17, `lint-rules/README.md` 16,
`lint-rules/factory.mjs` 15, `src/backend/testing/oxlint-factory-rules.test.ts`
15, three story files 14 to 18 each. The architecture notes are handled by
workstream 2. `package.json` changes were all dependency updates and are left
alone.

### Task 4.1: Derive unused-code dispositions from location

**Files:** Modify `scripts/check-unused-code.ts`, its test,
`scripts/unused-code-baseline.json`, `docs/knip.md`.

Of 62 production `test-support` entries, 55 sit in `/testing/`, `/test-utils/`
or a file named `*.test-helpers.*`, `*.test-support.*`, `*.test-harness.*`,
`*.story-fixtures.*` or `*.fixture.*`. Of the export entries, 183 share one
reason and 43 another.

- [ ] A file matching those conventions is test support without a baseline
      entry; rename the seven outliers to match or keep their entries.
- [ ] Where an export's disposition follows from its location (a capsule barrel,
      `src/components/ui/`), derive it; keep entries only for `review-required`.
- [ ] The baseline has 100 entries or fewer, and adding a test helper under a
      conventional name needs no baseline edit.

### Task 4.2: One lint rule per file

**Files:** Split `lint-rules/factory.mjs` (1,718 lines, 27 rules) into
`lint-rules/rules/<rule-name>.mjs`; split
`src/backend/testing/oxlint-factory-rules.test.ts` (841 lines) into
`lint-rules/rules/<rule-name>.test.ts`; move each rule's exception map from
`.oxlintrc.json` to `lint-rules/rules/<rule-name>.exceptions.json`; reduce
`lint-rules/README.md` to policy.

**Produces:** `lint-rules/factory.mjs` is an alphabetical index of imports. Each
rule file carries its description in `meta.docs.description`. One shared test
runs the stale-exception check over every `*.exceptions.json`.

- [ ] Rule names, messages and findings are unchanged: `pnpm lint` reports the
      same result before and after.
- [ ] Adding a rule touches its own three files, one index line and one
      `.oxlintrc.json` line.

### Task 4.3: Compose the application from subsystem slices (needs a step plan)

**Files:** `src/backend/app-context.ts` (679 lines; one 325-line
`createDefaultApplicationDependencies`), `src/test-utils/application-graph.ts`.

- [ ] Each subsystem directory under `src/backend/orchestration/` exports its
      slice of `ApplicationServices` and the function that builds it;
      `app-context.ts` spreads the slices.
- [ ] Adding a service to an existing subsystem does not edit `app-context.ts`
      or `application-graph.ts`.

### Task 4.4: Split the three most-edited story files

**Files:** `src/client/features/kanban/kanban-board.provider.stories.tsx` (664
lines), `src/client/features/chat/chat-transcript.stories.tsx` (673),
`src/client/routes/workspace-header-fixture.stories.tsx` (364).

- [ ] Split by scenario group into files of 300 lines or fewer, keeping every
      story title and export name so `pnpm test:storybook` ids are unchanged.

---

## Workstream 5: Tests that survive restructuring (P2, P5)

Baseline `vi.mock` targets: client modules 396, npm and Node 246, capsule
barrels 178, relative paths 153, other backend 131, infrastructure services 115,
`session` internals 97, `workspace` internals 31, other capsule internals 11.

### Task 5.1: Stop mocking another module's internals by path

**Files:** Create `lint-rules/rules/no-internal-module-mock.mjs` with its test
and exceptions file (after task 4.2; otherwise add it to `factory.mjs`).

**Produces:** a rule rejecting `vi.mock('<path>')` and `vi.doMock` when the
target is inside `src/backend/services/<capsule>/` and the test file is outside
that capsule, or, for a sealed session module, outside that module. Barrels are
allowed. Message: "Mock the `<capsule>` barrel or pass a fake from
`<capsule>/testing`; internal paths move."

- [ ] The exceptions file starts as today's violations; the stale-exception test
      shrinks it.
- [ ] Before each task 3.3 and 3.4 move, the moved files' entries are removed by
      converting those tests.

### Task 5.2: Capsule-owned fakes

**Files:** Create `src/backend/services/<capsule>/testing/index.ts` for
`session`, `workspace` and `github`, following the existing
`src/backend/services/agent-definition/testing/`.

**Produces:** `createFake<Capsule>Services(overrides?)`, typed against the
capsule barrel so a change to the public surface is a type error in the fake.

- [ ] Tests that mock those three barrels with hand-written objects use the
      fakes; the count of `vi.mock` calls on capsule barrels falls from 178.

### Task 5.3: No new module-level service singletons

**Files:** Create `lint-rules/rules/no-service-singleton.mjs` with its test and
exceptions file.

**Produces:** a rule rejecting `export const x = new X(...)` in
`src/backend/services/**` outside tests. The roughly 100 existing singletons are
the initial exceptions; new services export a factory composed by their
subsystem slice (task 4.3).

- [ ] The message names the factory pattern and the slice file to register in.

---

## Workstream 6: Recipes and agent configuration in the repository (P8)

### Task 6.1: Recipe format and the first five recipes

**Files:** Create `docs/recipes/README.md` and five recipes; create
`.claude/skills/<name>/SKILL.md` for each; modify `docs/README.md`,
`docs/architecture/agent-guidance.md`.

A recipe is 80 lines or fewer: when to use it, the files to touch in order, the
command that proves each step, and the mistakes it prevents. Each `SKILL.md`
holds only its `name`, a `description` saying when to use it, and a line
pointing at the recipe, so any agent tool can use the same text.

| Recipe                | Covers                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `add-prisma-model`    | Schema, migration, `prismaModelNames` and owner in `registry.ts`, accessor, generated client |
| `add-service-capsule` | Directory layout, barrel, registry entry, dependency declaration, guide pair                 |
| `add-background-job`  | `jobRunner` registration, cadence, shutdown, test                                            |
| `add-lint-rule`       | The three rule files, index line, fixture test (after task 4.2)                              |
| `verify-in-app`       | Task 1.4                                                                                     |

- [ ] Each recipe is followed once from a clean checkout by an agent given only
      the recipe; its mistakes are fixed in the recipe before merge.
- [ ] `pnpm check:guidance` covers `docs/recipes/` references and adds a rule: a
      recipe over 80 lines fails.
- [ ] `docs/architecture/agent-guidance.md` no longer says the repository owns
      no skills, and records where Codex discovers them once verified against
      the Codex documentation it already cites.

### Task 6.2: Project agent settings (after D3)

**Files:** Create `.claude/settings.json`.

- [ ] An allowlist of read-only and verification commands only: `pnpm check*`,
      `pnpm test*`, `pnpm typecheck`, `pnpm lint`, `pnpm knip`,
      `pnpm dev:sandbox*`, `git status`, `git diff`, `git log`, `gh pr view`,
      `gh pr list`, `gh pr checks`, `gh run list`, `gh run view`.
- [ ] Nothing that writes outside the working tree, pushes or merges.

---

## Workstream 7: Measure outcomes (P9)

### Task 7.1: Metrics script

**Files:** Create `scripts/agent-metrics.ts`, `scripts/agent-metrics.test.ts`;
modify `package.json` (`metrics:agents`).

**Produces:** `pnpm metrics:agents [--prs 300] [--json]`, printing Markdown or
JSON with:

- From `gh`: PR branches green on their first non-cancelled CI run; pushes per
  PR (median, p90); open-to-merge time; CI duration (median, p90); runs that
  failed then passed on the same commit; merged PRs whose title starts with a
  fix verb and whose body references a PR merged in the previous 7 days.
- From the tree: lines and estimated tokens of the guide chain for each
  directory holding an `AGENTS.md`; total guidance lines against source lines;
  the ten most-edited files over the last 300 commits with their share;
  production files of 900 lines or more; `vi.mock` counts by target class;
  baseline and exception-list sizes; `sessionModuleCycles` length.

The pure functions take parsed `gh` JSON and file lists so tests need no
network.

- [ ] Tests cover each calculation with fixture data, including a branch whose
      first run was cancelled and a PR with one push.
- [ ] Its output for commit `a571ce9fe` matches the baseline table above; where
      it differs, correct the table.

### Task 7.2: Weekly report and the guidance experiment rule

**Files:** Create `.github/workflows/agent-metrics.yml`; modify
`scripts/ci-workflow.test.ts`, `docs/architecture/agent-guidance.md`.

- [ ] A weekly scheduled workflow runs `pnpm metrics:agents`, writes the
      Markdown to the job summary and uploads the JSON as an artifact. Nothing
      is committed (P7).
- [ ] `agent-guidance.md` replaces "behavioral improvement has not been
      measured" with the rule: a guidance or structure change states which
      metric it expects to move and is checked against the next report.

---

## Done

The program is complete when every target in the baseline table is met or
replaced by a recorded decision, `legacyNoteCeilings` and `sessionModuleCycles`
are empty. The pull request that says so deletes this file and the paragraph in
the principles document that links to it.
