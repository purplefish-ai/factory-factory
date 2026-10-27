# Session Selection Implementation Plan

**Goal:** Show the provider and model that will actually be used, starting from
the user's saved defaults, and preserve explicit choices through creation,
configuration loading, stopped edits, and resume.

**Spec:**
[Provider and model selection](../../architecture/agent-runtime.md#provider-and-model-selection).
New launches use the user's saved provider-specific defaults; explicit choices
survive loading, settings refreshes, and failures. One compact picker serves
creation and current-session model changes. Another provider starts a new
conversation. Startup and resume apply the stored choice before prompts; stale
results cannot replace a newer selection, and failures restore confirmed state.

**Delivery:** A reviewed PR merges only with green checks and no outstanding
comments.

**Architecture:** Backend startup applies the stored model before publishing a
ready configuration or permitting prompts. Client hydration distinguishes
unknown capabilities from unsupported settings. Creation owns an explicit
provider/model selection independent of the active conversation; a reusable
quiet picker serves creation and current-session model changes.

**Tech stack:** Existing React, tRPC, ACP adapters, Zod, Vitest and Playwright.

## Global constraints

- Use pinned Node 26.12.1 and pnpm 12.15.0; no new dependencies.
- The user's saved provider/model seeds each new selection. A user's explicit
  choice wins over subsequent settings refetches.
- Existing conversations retain their provider. Another provider means a clearly
  identified new conversation, never silent conversion of existing history.
- Never silently send another provider's model or replace an explicit model with
  the native default. Missing/unsupported values must remain truthful.
- Preserve drafts, attachments, read-only workflows, cancellation, runtime
  identity guards and startup readiness.
- Quota/context controls retain their existing minimal appearance.

## Review focus

- New workspace / new chat / quick action share saved defaults; Codex-to-Claude
  creation never copies an active Codex model.
- New and resumed ACP sessions apply selected model before first prompt and
  publish the confirmed configuration; stopped model edits survive restart.
- Catalog discovery cannot persist stale defaults over a newer live edit.
- Stored reasoning/planning choices survive empty-capability hydration, while
  supported server model selection supersedes hardcoded bootstrap values.
- Partial ACP configuration, disconnected/loading/busy states and narrow layouts
  keep selectors visible and explain temporary unavailability.

## Task 1: Apply and retain backend selections

**Files:** ACP factory/configuration helpers and tests; session startup/config
services and tests under `src/backend/services/session/service/`.

- [x] Promote the failing ACP default-versus-native reproduction from
      `/private/tmp/ff-selection-backend-experiment.test.ts` into permanent
      tests.
- [x] Cover saved model on new/resumed startup, stopped edit then resume,
      unsupported model behavior and delayed inactive catalog reads.
- [x] Apply a supported explicit model before ready/first prompt and ensure the
      returned snapshot reflects that confirmed value; do not alter browse-only
      sessions.
- [x] Make cached model editing and catalog fallback preserve selection and
      guard against obsolete asynchronous writes.
- [x] Run focused backend tests and typecheck.

## Task 2: Preserve client configuration through hydration

**Files:** `src/client/features/chat/chat-settings.ts`, chat reducer/settings
slice, session/persistence/action hooks and co-located tests.

- [x] Promote the hydration/default-model experiments from
      `/private/tmp/ff-selection-client-experiment.test.tsx` into regressions.
- [x] Preserve restored settings while capabilities are unknown, adopt confirmed
      server model at initial hydration, and retain explicit current-session
      choices without sending stale bootstrap settings.
- [x] Verify session switches, partial capability updates and outbound message
      settings, including reasoning and planning.
- [x] Run focused reducer/hook tests and typecheck.

## Task 3: Unify provider/model selection and creation defaults

**Files:** Reusable selection feature/components, InlineWorkspaceForm, session
collection commands, workspace detail and Quick Chat integration, ChatInput
controls, stories and tests.

- [x] Add regressions for settings-refetch reset, cross-provider model leakage,
      all creation entry points, and partial ACP options hiding model controls.
- [x] Add one compact provider/model picker with provider-appropriate catalogs,
      explicit loading/disabled states and current-versus-new session semantics.
- [x] Seed provider/model from saved user defaults exactly once per
      draft/context; preserve per-provider explicit choices and submit them to
      creation.
- [x] Use confirmed current-session model/configuration in the composer,
      retaining model access when only unrelated ACP options arrive.
- [x] Update stories, verify light/dark and narrow layouts, and run mobile
      tests.

## Task 4: Verify, review and ship

- [x] Update runtime/workspace documentation for selection precedence and UI.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, full tests, integration tests,
      production/Storybook builds as relevant, mobile tests and `pnpm check`.
- [x] Repeat disposable live default/edit/restart checks with Codex and
      available Claude runtime; do not send inference prompts solely for UI
      verification.
- [ ] Review the complete diff, fix actionable findings, create and attach a
      ready PR, and resolve all review threads.
- [ ] Merge only the verified PR revision with green checks and no outstanding
      comments; report the PR and merge result.

## Progress

- Started from clean main at `ff07c77e` on `codex/session-selection`.
- Prior exploration: 338 existing tests passed; 15 diagnostic cases exposed
  seven failures with eight controls passing. Live Codex reproduced saved 6 Sol
  becoming 6.1 Sol on startup and stopped 6 Luna reverting on restart, without
  prompts.
- User has approved implementation and explicitly authorized PR creation and
  merge after green checks and comment resolution.
- Backend, hydration, picker and creation tasks are implemented with permanent
  regressions. A fresh independent review identified rejected-model rollback and
  stale acknowledgement display; both received red/green tests and fixes.
- Additional regressions cover draft isolation before autosave, disconnected
  setting changes, and advertised inactive Codex model edits before the first
  native snapshot. Model/configuration failures carry optional request IDs;
  legacy callers and success/broadcast message shapes remain compatible.
- Live disposable checks passed for Codex saved 6 Sol and stopped 6 Luna, Claude
  saved Sonnet and stopped Opus, and an explicit workspace model override. The
  existing Restart endpoint sends a continuation prompt, so the final no-prompt
  checks explicitly start stopped sessions with an empty prompt.

- Final local verification before base integration: 7,543 full-suite tests and
  203 integration tests passed (three skipped), mobile 3/3, typecheck,
  repository checks, production and Storybook builds passed.
  Narrow/light/dark/keyboard states and real provider transitions were checked.
- Review fixes serialize complete configuration transactions, validate explicit
  cross-provider models before workspace persistence, preserve stopped edits
  through startup failures, and expose retryable defaults errors. Additional
  regressions cover real keyboard activation, Storybook Controls updates,
  confirmed-empty capabilities, and session-loading safety timers.
- After review fixes: 7,662 full-suite tests and 210 integration tests passed
  (three skipped), mobile 3/3, typecheck, production and Storybook builds
  passed.
- Latest main was integrated in an isolated checkout. The combined revision
  passed 7,709 full-suite tests, 210 integration tests (three skipped), mobile
  3/3, typecheck, and both builds. The only merge conflict retained both sets of
  test imports.
