# Launch Thinking and Plan Implementation Plan

> Historical implementation record. The original task supplied delivery
> authorization; this record does not independently authorize repository
> actions.

**Goal:** Launch Claude and Codex with the thinking level and Plan state shown
in the compact controls, and retain confirmed choices through resume.

**Architecture:** A cached selected-model discovery endpoint exposes real native
thinking/planning options. Session creation persists typed launch intent; the
startup owner applies it before readiness, while confirmed snapshots own resume.
Shared client launch controls keep provider-specific drafts and gate creation.

**Tech stack:** Existing TypeScript, React, tRPC, Zod, Prisma JSON metadata and
ACP adapters; Node 26.12.1 and pnpm 12.15.0. No new dependencies or migration.

**Spec:**
[Approved launch controls](../specs/2026-10-27-launch-thinking-plan-design.md).

## Global constraints

- Use capsule/feature barrels across boundaries and preserve readiness fences.
- Discovery sends no inference prompt, returns no guessed capability list, and
  has bounded process cleanup and a bounded 30-second successful-result cache.
- Preserve saved defaults, explicit null/native-default intent, permissions,
  browse-only behavior, and reviewer restrictions.
- Run broad formatting/lint separately from full tests that create lint
  fixtures.

## Review focus

- A late capability query after a provider/model switch cannot alter the new
  draft.
- A model that lacks the selected effort must expose the invalid choice visibly.
- Plan off must not broaden Claude access; failed Plan application must not
  prompt.
- Initial auto messages must not overwrite the selected effort before dispatch.
- Intermediate snapshots must not prematurely consume launch intent; resumed
  sessions must retain later confirmed edits over original intent/global
  changes.

## Task 1: Native discovery, transport and startup (backend owner)

Files: `src/shared/session-launch.ts`, session ACP/lifecycle/data/resources,
`src/backend/trpc/session.trpc.ts`, `workspace.trpc.ts`, workspace creation and
launch orchestration, plus focused co-located tests and necessary composition.

Interface: `session.getLaunchOptions({provider, model?})` returns confirmed
`{provider, model, reasoning:{options, selected?, defaultValue?}, planMode:{supported, selected}}`.
`options` use `ChatReasoningOption`; optional defaultValue is the native
writeable choice. Creation accepts `reasoningEffort?: string | null` and
`planModeEnabled?: boolean`.

- [x] Add failing tests for selected-model options, cache/error cleanup,
      explicit/default effort, Plan on/off, unsupported choices and resume.
- [x] Observe failures, implement discovery and validated durable launch intent,
      then apply/confirm it before readiness. Consume intent only at final
      confirmation; restore identity-matched snapshots on resume.
- [x] Extract focused helpers where needed to preserve file-length ceilings.
- [x] Run focused tests, typecheck and boundary checks; report stable
      interfaces.

## Task 2: Shared real launch controls (client owner)

Files: `src/client/features/session-selection/`, InlineWorkspaceForm,
MainViewTabBar, Quick Chat, collection commands, creation route composition,
stories and actual component/hook integration tests.

- [x] Add failing tests for real menu selection/keyboard activation, Plan state,
      provider drafts, delayed queries, invalid effort, failure/retry, and
      payloads.
- [x] Implement `SessionLaunchControls` and extend `useSessionLaunchSelection`
      with per-provider thinking/Plan drafts and real selected-model queries.
- [x] Replace the workspace mode dropdown and integrate the same controls into
      new-session creation; keep navigation and periodic creation independent.
- [x] Run focused tests/typecheck and verify light/dark/narrow Storybook states.

## Task 3: First dispatch and actual provider verification (parent owner)

Files: workspace-init orchestration, session dispatch and focused regressions;
cross-boundary integration tests in `src/test-utils/`; runtime documentation.

- [x] Add failing first-prompt regressions proving launch effort/Plan survive
      automatic workspace messages and absent client settings.
- [x] Preserve confirmed startup configuration through enqueue and dispatch,
      then run end-to-end component/transport/startup tests.
- [x] Test real Claude and Codex in disposable workspaces: discovered native
      levels, explicit and native defaults, Plan on/off, and stop/resume.
- [x] Update runtime docs and run required full checks, tests, builds and
      mobile.

## Review record

Independent review covered the implementation and regressions below. Delivery
status and review discussion are tracked in the pull request.

## Verification evidence

- Full suite: 700 files, 7,850 tests passed; two opt-in files skipped.
- Integration: 28 files, 210 tests passed; two opt-in files skipped.
- Typecheck, repository guardrails, production and Storybook builds passed.
- Three mobile browser baselines and light/dark/narrow Storybook states passed.
- Disposable real Claude and Codex checks covered native discovery, first
  responses with Medium and Plan on, native Default, Plan off, unsupported
  choices, later edits, and stop/resume after global defaults change.
- Final-source native resume checks also covered editing unconsumed launch
  intent without sending additional prompts.
- Independent review regressions cover first-dispatch overrides, snapshot races,
  durability failures, pending edits, and their transient-write retry.
