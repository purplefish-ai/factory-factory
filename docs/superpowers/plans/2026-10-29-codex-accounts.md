# Codex Accounts Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans task-by-task. Follow TDD and preserve other
> workers' changes.

**Goal:** Support one or many Codex accounts, native browser login from an Add
Codex account dialog, separate usage, Auto/manual new-conversation selection,
and immutable saved account bindings.

**Architecture:** A Codex-account capsule owns account rows, isolated native
profiles, login, observations and selection reservations. Session creation binds
the account once; runtime, history and discovery carry that account context
explicitly. Claude behavior stays unchanged. Existing Codex sessions use the
native-default profile.

**Tech Stack:** Existing TypeScript/Prisma/SQLite, tRPC, React, ACP 2.3.0 and
bundled Codex 0.164.0. No dependencies required.

**Spec:** ../specs/2026-10-29-multi-account-usage-balancing-design.md
(Codex-first MVP; handoff and Claude deferred).

## Global constraints

- Node 26.12.1 and pnpm 12.15.0; source and parsed JSON boundaries use Zod.
- OAuth stays native; managed profile credentials stay outside repositories
  under FF data, restricted to the OS user.
- Native default preserves existing home/environment behavior; managed profiles
  scrub overriding API-key/provider variables.
- Account management and account-level usage remain trusted-local operations. No
  credentials, raw native stderr or arbitrary paths in transport responses.
- A persisted conversation never resolves Auto again. Missing/disabled-for-Auto
  accounts, identity mismatch and wrong profile history cannot trigger
  cross-account fallback.
- Single-account installations continue working without setup; support arbitrary
  numbers of managed accounts with enable/disable and Add account.

## Review focus

- Legacy sessions and API-key/native-default users retain behavior after schema
  migration.
- Concurrent Auto assignments reserve candidates, release on failed creation and
  do not count unknown quota as unused quota.
- Browser login is sequential/cancellable/bounded; duplicate identities and
  changed identities cannot silently rebind sessions.
- Managed-only authentication works when global/default Codex is signed out; all
  automated creation paths bind accounts.
- Account context follows browsing/history, usage, launch options and model
  discovery, and is never accepted as a raw environment/path from clients.

## Interfaces

Shared `src/shared/codex-accounts.ts` exports Zod DTOs/types:

- `CodexAccountSummary`: id, label, kind (`NATIVE_DEFAULT`/`MANAGED`), enabled,
  authenticated, email/planType nullable, usage (`ProviderPlanUsage`).
- `CodexLoginState`: accountId, status
  (`pending`/`completed`/`failed`/`cancelled`), optional authorizationUrl and
  message.

`codexAccountService` public methods:

- `getAccounts()`, `createAccount(label)`,
  `updateAccount(id, {label?, enabled?})`.
- `startLogin(id)`, `getLoginStatus(id)`, `cancelLogin(id)`.
- `getUsage(id?)` and `getRuntimeContext(id?)`; context has accountId, homeDir,
  sessionsDir, env (server only).
- `getHistoryContext(id?)` resolves the saved profile for offline local history
  without authentication, model or quota probes.
- `getPreviewRuntimeContext({accountId?, model?})` selects the profile for
  launch and model discovery without reserving it or consuming a model turn.
- `withAccountReservation({accountId?, model?}, async accountId => result)`
  serializes allocation and releases its reservation on every callback
  completion.

Transport `trpc.codexAccounts`: list, create({label}),
update({id,label?,enabled?}), startLogin({id}), loginStatus({id}),
cancelLogin({id}), getUsage({id}). Creation inputs accept optional
`codexAccountId`; absent means Auto for NEW Codex sessions. Existing/bound
sessions use their persisted value, with null reserved for legacy native-default
compatibility. `session.getProviderUsage` accepts optional codexAccountId;
session usage UI sends the bound value. Launch/catalog reads accept the selected
account where applicable.

## Tasks

### 1. Account capsule and native profiles

Files: new
`src/backend/services/codex-accounts/{index.ts,service/*,resources/*}`,
`src/shared/codex-accounts.ts`; schema/migration/generated client, registry,
config getters. Own these files exclusively.

- [x] Write failing tests for isolated environment/history paths, selection with
      limits/unknown quota/concurrent reservations, single-account compatibility
      and release-on-failure.
- [x] Run focused tests and record red evidence.
- [x] Implement schema migration (stable native-default row, existing Codex
      session bindings), capsule, restricted managed directories, native
      metadata/models/quota reads, TTL caches and native regular-browser login
      with cancellation/identity checks.
- [x] Generate Prisma client; verify schema/migration and focused tests green.

### 2. Session binding and account-scoped runtime

Files: `src/backend/services/session/**`, including accessors/types, ACP
options/factory, history loaders, catalogs, launch options and core composition.
Own these files exclusively. Capsule/config API supplied by Task 1; coordinate
interface changes with root.

- [x] Write failing tests showing manual/Auto account binding, immutable
      updates, saved-account resume/history and independent cache/probe
      environments.
- [x] Run focused tests and record red evidence.
- [x] Bind through all session-data creation paths (including dedicated PR
      acquisition), carry server context into spawn/browse/discovery/history and
      usage, require exact-account resume, preserve Claude/native-default
      behavior.
- [x] Verify focused tests green; report necessary root-layer wiring and
      fixtures.

### 3. User interface

Files: `src/client/**` only, new account-management feature and shared account
selector where appropriate, existing settings surfaces/launch selection/usage
controls. Own these files exclusively. Use the agreed tRPC DTOs and optional
codexAccountId creation input.

- [x] Write failing UI tests for Add dialog/login pending/success/failure, many
      accounts, enable toggles, Auto/manual selection and bound-account usage.
- [x] Implement accessible account management in settings with polling only
      during login; render native-generated authorization URL as a link the
      human opens. Use ConfirmDialog/AlertDialog where confirmation is needed.
- [x] Propagate explicit selection through all human launch flows, keep account
      selector out of Claude mode, show saved account on existing sessions, and
      preserve one-account ergonomics.
- [x] Add Storybook states, run focused tests and inspect changed UI.

### 4. Application wiring and integration

Files: app-context, tRPC account router/root registration,
shared/session/workspace launch boundaries, orchestration and CLI health
preflight; documentation. Root owns these files and integration fixes.

- [x] Add trusted-local account procedures and validate outputs; wire
      singleton/factory dependencies and shutdown login cleanup.
- [x] Pass codexAccountId through session/workspace creation boundaries and
      account-aware discovery endpoints; avoid global auth preflight rejecting a
      usable managed profile.
- [x] Test trusted-local enforcement, managed-only health, automatic creation
      policies and protocol projections.
- [x] Run targeted integration suites, full tests, typecheck,
      ownership/import/schema checks, production/Storybook builds and UI
      inspection. Review through Cubic plus independent final review; fix
      material findings.
- [x] Update runtime docs and this plan with verification and remaining limits.
      Deliver a reviewable branch; do not merge or publish.

## Progress

- Approved scope: user explicitly requested implementation of Codex-only MVP and
  one-to-many Add-account flow.
- Prior live macOS spike passed distinct accounts, quota probes, concurrent ACP
  prompts and exact provider-process resume with separate recall.
- Execution begins in a managed worktree; source checkout's untracked design is
  preserved there.

## Delivery and verification

Implemented in the managed worktree on `codex/codex-accounts`. Source checkout
changes were preserved. Claude account management and generated handoffs remain
deferred.

- Full suite: 8,772 passed, 3 skipped; integration: 211 passed, 3 skipped.
- Mobile browser checks: 3 passed; settings and launch controls visually
  inspected at desktop and mobile sizes.
- `pnpm check:fix`, `pnpm typecheck`, `pnpm check`, Prisma schema/generation
  checks, production build and Storybook build passed.
- Native two-profile metadata/model/usage/identity probes passed. Actual native
  OAuth startup/cancel passed without credential adoption; prior four-prompt
  concurrency/provider-resume smoke passed.
- Cubic and independent reviews completed. Fixed scope pinning, staged auth
  commit, cancellation, model-specific quota filtering, independent
  probes/caches, offline history, per-session skills, managed-only UI health,
  Windows layout and strict account-aware backup restore.

Implementation decisions: native-default browser re-login remains in the native
CLI, because its external keyring/config ownership differs from managed
profiles. Managed profiles use file-scoped native credentials and pin verified
account IDs. Email-only native fallback is explicitly unverified for workspace
scope and cannot be counted as extra quota alongside an overlapping verified
managed profile. Version 7 exports include metadata only; imported
native/conflicting bindings use unavailable managed profiles until explicitly
reconnected. The pinned Windows `bin/` executable layout is preferred; an
alternate owned layout is accepted only when its executable exists.
