# Application Update Prompts Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for supervisor and
> integration work; independent UI and release-check tasks may run in parallel.
> Steps use checkbox syntax for tracking.

**Goal:** Notify users of new app and bundled runtime releases, install
supported updates on click, and merge the verified PR.

**Architecture:** Shared update contracts join a cached backend release checker,
a CLI-owned staged installer, and nonblocking banner rows. The CLI retains
status across backend restarts; trusted-local mutations request or cancel
installation.

**Tech Stack:** TypeScript, Zod, tRPC, React, Vitest, Node child processes,
pnpm.

**Spec:**
`docs/superpowers/specs/2026-11-04-application-update-prompts-design.md`

## Global Constraints

- Provider runtimes update with Factory Factory; never update an unrelated
  global provider CLI.
- Registry errors are nonblocking, bounded, and cached.
- Dismissal belongs to each notice/version; unsupported installations receive
  guidance.
- Preserve launch options and database; wait for agent work and fence admission
  before restart.
- Stage and verify before activation; preserve recovery status outside the
  replaced package.

## Review Focus

- Offline and malformed responses must leave the running app usable.
- Concurrent browser requests must not install twice.
- Idle live ACP processes must not prevent all future updates.
- New work racing shutdown must not be silently abandoned.
- Migration failure must not cause unsafe automatic package/database downgrade.

### Task 1: Contracts and cached release detection

Files: `src/shared/application-updates.ts`,
`src/backend/services/application-update/`,
`scripts/prepare-runtime-metadata.mjs`, `package.json`.

Interfaces: `ApplicationUpdates`, `ApplicationUpdateStatus`, `UpdateNotice`;
release service `check(): Promise<ReleaseCheck>`, current installed package and
runtime versions. Registry metadata includes optional explicit bundled runtime
package versions.

- [x] Write failing tests for stable version ordering, cached/coalesced lookup,
      offline and malformed responses, multiple runtime notices, unsupported
      installs.
- [x] Run focused tests and observe failures.
- [x] Implement timeout-bound validated release lookup and packaging metadata.
- [x] Run focused tests and inspect diff.

### Task 2: Shared update notices

Files: `src/client/components/application-update-banner*`,
`src/client/root.tsx`.

Interfaces: `admin.checkUpdates`, `admin.requestUpdate({version})`,
`admin.cancelUpdate`; shared contracts from Task 1.

- [x] Write failing tests for simultaneous rows, independent version-specific
      dismissal, pending/cancel/error states, inaccessible storage, and
      reconnect/reload.
- [x] Implement the banner using existing CLI health banner styling and shared
      buttons/spinners.
- [x] Add Storybook examples/play checks for simultaneous app/provider updates
      and failures.
- [x] Run focused tests and Storybook checks.

### Task 3: Staged installation and supervised restart

Files: `src/cli/application-update*.ts`, `src/cli/serve-session.ts`, backend
update orchestration, config and runtime admission helpers.

Interfaces: shared validated IPC messages; supervisor accepts a pinned
advertised version, prepares an npm-global package on the same volume, waits for
backend quiescence, activates, migrates and restarts at the same address.

- [x] Write failing tests for eligibility, fixed arguments, coalescing,
      cancellation, staging failure, failed activation, status recovery and
      launch preservation.
- [x] Implement supervisor-owned status and staged installer; refuse unsupported
      installations.
- [x] Implement backend idle checks and an admission fence; integrate
      trusted-local procedures.
- [x] Run focused tests, then inspect recovery behavior including migration
      failures.

### Task 4: Verification and delivery

Files: current installation/runtime docs and final integration fixes.

- [x] Update current docs and record material implementation decisions here.
- [ ] Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`,
      `pnpm test:storybook`, `pnpm check` and relevant integration checks.
- [ ] Obtain a fresh whole-branch review; fix valid issues and rerun affected
      checks.
- [ ] Commit, push, create a ready-for-review PR with actual validation results.
- [ ] Monitor latest-head CI and unresolved review comments; resolve valid
      issues.
- [ ] Merge only when checks are green and no outstanding comments remain.

## Execution decisions

The user explicitly authorized implementation, PR creation and conditional
merge. Continue without an additional plan-approval pause. Use the existing
isolated worktree; do not create another checkout. Only global npm installs
launched through the supervised production CLI receive automatic installation;
all other modes get explicit guidance.

Final review decisions: version discovery resolves exported runtime entrypoints
when package manifests are hidden by exports. Failed update status remains
visible independently of release rows; retries use the supervisor's previously
validated pinned target when registry metadata is unavailable after restart. ACP
admission is injected by composition to preserve its dependency isolation.
Interrupted recovery runs before migrations and relaunches the restored CLI.
