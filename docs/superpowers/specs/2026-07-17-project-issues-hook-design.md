# Shared Project Issues Hook Design

## Problem

The sidebar and Kanban provider independently select GitHub or Linear, run the same provider queries with the same timing, synchronize GitHub CLI health, normalize raw issues, select loading/refetch state, and remove issues linked to workspaces. This duplication lets the two issue lists drift and obscures which layer owns linked-workspace filtering.

The provider routers already apply `filterIssuesLinkedToActiveWorkspaces`, including the policy that archiving and archived workspaces no longer reserve an issue. Durable filtering therefore belongs on the server. The client still needs transient cache reconciliation: a newly created linked workspace can reach the live workspace cache before the 60-second provider query refresh, and a concurrent poll can expose an issue while Kanban optimistically archives its workspace.

## Considered Approaches

1. Add one typed `useProjectIssues` client hook over the existing GitHub and Linear routers. This is the recommended approach because it removes the duplicated client orchestration while preserving the established provider contracts and keeping the change focused.
2. Add a provider-neutral backend `issues.listForProject` endpoint now. This would also centralize normalization, but it requires a new cross-service API and a combined response contract for GitHub health. The issue describes this as a longer-term direction rather than the required short-term change.
3. Extract only pure normalization and filtering helpers. This would reduce some repeated lines, but query enablement, timing, CLI health synchronization, loading state, and refetch selection would remain duplicated in both consumers.

## Design

Create `src/client/hooks/use-project-issues.ts` with a typed `useProjectIssues` hook. It accepts a project ID, an `IssueProvider`, and client workspace-link state. It always declares both provider query hooks, enables only the configured provider, defines the 60-second polling and 30-second stale timing once, synchronizes GitHub CLI health from the GitHub response once, normalizes only the active provider response, applies the shared transient visibility helper, and returns issues plus the selected loading and refetch state.

The sidebar will pass its live workspace links so a provider result cached before issue-based creation cannot appear beside the new workspace. As before, it will wait for workspace state before exposing provider issues.

Kanban will pass its live workspace links plus links recorded in `archivingWorkspaceIssueLinks`, which must remain hidden while an optimistic archive request is pending. The pure helper in `src/client/lib/project-issue-visibility.ts` will be explicitly documented as transient cache-skew protection rather than the durable eligibility policy.

The existing provider-neutral backend helper remains the single durable owner. Its documentation will state that clients may apply only transient optimistic exclusions. No provider-neutral backend router is added in this change.

## Data Flow

1. The consumer provides `projectId`, `IssueProvider`, live workspace links, and optional pending optimistic links.
2. Both tRPC hooks are declared, but only the selected provider query is enabled.
3. The selected response is normalized into `NormalizedIssue[]`.
4. GitHub responses update the shared CLI health cache only when the existing health policy permits it.
5. The hook uses the shared visibility helper to reconcile normalized issues with current client workspace links and optional in-flight archive links.
6. The hook returns the reconciled issues and active query's loading/refetch state to both consumers.
7. Provider routers continue fetching active workspaces and apply `filterIssuesLinkedToActiveWorkspaces` before returning their raw provider issues.

## Error Handling and Edge Cases

- An undefined project ID disables both provider queries and uses an empty string only as the inert tRPC input.
- Unknown provider strings are prevented by the `IssueProvider` input type; GitHub and Linear remain exhaustive choices.
- Missing provider data returns `issues: undefined`, preserving current loading behavior.
- GitHub health is not synchronized for Linear responses, GitHub responses without health, or authenticated GitHub responses with an issue-fetch error.
- GitHub issue number `0` and empty Linear IDs are handled by exact null checks rather than truthiness where issue-key matching is performed.
- Cached workspace links and in-flight archive links filter only the active provider's matching key; null links and the other provider's keys have no effect.
- When an archive fails, Kanban removes the temporary exclusion in its existing `finally` path; the server-filtered issue list remains authoritative.
- Archived and archiving workspace behavior remains covered by the provider router policy, not duplicated in the hook.

## Testing

Add a jsdom hook test that mocks the tRPC hook boundary and renders a small React harness. Cover GitHub selection, common query timing, GitHub normalization, health synchronization, active refetch selection, Linear selection and normalization, and disabled queries without a project.

Add pure helper tests for GitHub and Linear cache reconciliation, an in-flight archive link whose workspace is already hidden, unlinked issues, null links, and exact numeric issue-key handling.

Keep and extend the GitHub and Linear router tests so both prove that active workspace links are filtered while archiving and archived links are returned. Run the hook and router tests through a red-green cycle, then run `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.
