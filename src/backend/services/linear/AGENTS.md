# Linear capsule

Calls to the Linear API for a project whose issue provider is Linear: key
validation, team and issue reads, and moving an issue to another workflow state.
The [services guide](../AGENTS.md) covers capsule layout and boundaries. Bare
file names below are in `service/`; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This capsule owns the `@linear/sdk` client and every request made through it. It
owns no Prisma model and never stores, encrypts or decrypts an API key: callers
pass a decrypted key. It does not own:

- The project's issue provider, team and encrypted key: the `Project` row in
  `src/backend/services/workspace/`, written through `updateProjectSettings` in
  `src/backend/orchestration/project-settings.orchestrator.ts`, which encrypts a
  new key once before persistence.
- Keeping the encrypted key out of responses: `toPublicProject` in
  `src/backend/orchestration/project-query-projection.ts`, which replaces it
  with `hasApiKey`.
- Decrypting the key for a request: `src/backend/trpc/linear.trpc.ts` and the
  orchestration that marks issues started or completed.
- Marking an issue started when its workspace initializes:
  `src/backend/orchestration/workspace-lifecycle/workspace-init.orchestrator.ts`.
- Completing an issue when its PR merges, once per collector lifetime:
  `src/backend/orchestration/snapshots/linear-merge-completion.orchestrator.ts`.
- The settings form that validates a key and picks a team:
  `src/client/routes/admin/IssueTrackingSection.tsx`.

## Public surface

`index.ts`: `linearClientService` (`validateApiKey`, `listTeams`,
`validateKeyAndListTeams`, `listMyIssues`, `getIssue`, `findWorkflowState`,
`transitionIssueState`), `linearStateSyncService` (`markIssueStarted`,
`markIssueCompleted`) and the `Linear*` types.

## Invariants

- The team list reads every page and fails rather than return a partial list.
  `linear-client.service.test.ts`.
- A transition reports success only when Linear accepts the update, and the
  state sync service never throws: a failed transition is logged and reported as
  not completed. `linear-client.service.test.ts`,
  `linear-state-sync.service.test.ts`.

## Map

- `linear-client.service.ts`: one SDK client per call; validation, teams, the
  viewer's unstarted issues in a team, issue lookup and transitions to the
  team's first workflow state of a type.
- `linear-state-sync.service.ts`: best-effort `started` and `completed`
  transitions for workspace lifecycle events.
