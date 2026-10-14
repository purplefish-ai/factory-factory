# PR event delivery destination implementation

Implement the approved design in
`docs/superpowers/specs/2026-10-09-pr-event-delivery-modes-design.md` on the
existing PR branch. Keep one event pipeline and keep main mode as the default.

## 1. Persist configuration and ownership

- Add `deliveryMode String @default("MAIN")` to WorkspacePRMonitoring.
- Add WorkspacePRDedicatedSession with prId primary key, PR cascade relation,
  nullable unique sessionId and AgentSession SetNull relation. Session owns it.
- Add an additive migration, regenerate Prisma and update registry, accessor
  ownership guards and FK checks. Do not edit published migrations.
- Define shared `PRDeliveryMode = 'MAIN' | 'DEDICATED'` and
  `PR_DEDICATED_WORKFLOW = 'pr-monitoring'`. Add mode to projections and backup
  schemas with backward-compatible defaults. Delivery request mode is optional
  for old queue fixtures; effective default is MAIN.
- Workspace resources implement mode-aware binding CAS, event epochs, main-only
  enable controls, claim authorization and bound-session pause/resume. Claims
  read dedicated bindings; session resources alone write them.
- Prove defaults, stale CAS, wrong PR/workspace claims, frozen identity,
  dedicated stop/resume, migration and backup continuity with focused tests.

## 2. Acquire dedicated conversations

- Add session resource `pr-dedicated-session.accessor.ts` and service facade
  `acquirePRDedicatedSession({workspaceId, prId, provider, model, maxSessions})`.
  Return `created`, `reused`, `limit_reached`, or `unavailable` plus the session
  record when acquired. Atomically validate attached PR and READY workspace,
  enforce the normal limit for creation and bind one conversation per PR.
- Reuse saved records even when their process is cold. Provider identity must
  remain intact. Existing sessions are not recreated when resume fails.
- Add orchestration helper
  `ensureDedicatedPRRecipient(target, services, isCurrent)` using normal
  workspace defaults. Create provider identity once with empty initial prompt;
  subsequent wakes use existing strict resume.
- Fence every awaited creation/start step against monitoring revision changes
  and user stop. Avoid starting a sibling while another agent is working.
- Test concurrent acquisition, independent PRs, caps, missing targets, provider
  bootstrap and exact identity reuse, including changes during awaits.

## 3. Share delivery and recovery

- Extend setPRMonitoring and the Ratchet compatibility API with deliveryMode.
  Auto-bind issue sessions only in MAIN mode. Dedicated mode does not require a
  main conversation, but retains its preference when switching back.
- Refactor wake/guard/prepare into small destination helpers. Resolve MAIN from
  config or DEDICATED from the PR binding. Recover all frozen recipients before
  routing new batches. Preserve old receipt and cancellation semantics.
- Include request mode in queue tokens/guards, but never mutate the identity of
  a claimed batch. Dedicated batches include trusted maintenance context in the
  existing bounded event prompt; both modes show the same chat cards.
- Extend pause/resume port ownership checks to dedicated bindings and preserve
  revision and synchronous resume fences. Update snapshot projections.
- Add integration tests for multiple PR recipients, repeated event reuse,
  workspace busy state, in-flight mode changes, frozen recovery and main mode.

## 4. Expose the destination choice

- Extend workspace.toggleRatcheting input with the shared mode schema.
- Update use-toggle-ratcheting and the workspace PR menu with MAIN and DEDICATED
  choices, current selection, mutation pending state and cache sync.
- Keep the stable recipient dialog outside dropdown lifecycle and display it
  only when MAIN needs a recipient. Preserve selected mode through retry.
- Add component regressions and stories for both modes and mobile selection.

## 5. Review and delivery

- Update architecture documentation and backup exports/restoration for mode and
  dedicated bindings. Inspect focused diffs and obtain a scoped review.
- Run check:fix, typecheck, affected tests, full tests, check,
  check:prisma-schema, production build and generated-client drift checks. Lower
  reduced legacy file ceilings without allowing growth.
- Commit and push to PR #2447, update its description for destination choice,
  and continue the existing Cubic/CI monitor. Do not merge the PR or reply to
  reviewers without authorization.
