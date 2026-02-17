# Linear Issues Integration Plan

## Context

Currently, Factory Factory pulls GitHub Issues (assigned to the user) into the Kanban board's intake column. This is hardcoded as the only issue provider. The goal is to make the issue source configurable per-project, supporting both GitHub Issues (default) and Linear Issues as providers.

When Linear is selected, the app should:
- Fetch the user's Linear issues (Todo state, current cycle, assigned to me) and display them in the Kanban intake column
- Allow starting workspaces from Linear issues (same as GitHub flow)
- Auto-update Linear issue status as the workspace lifecycle progresses (started -> in progress, PR merged -> done)
- Show clear error states if the Linear connection fails, with a link to admin settings

**Key decisions made:**
- Global Linear API key (user-level), per-project team selection via auto-populated dropdown
- Use `@linear/sdk` npm package (official typed SDK)
- No Linear MCP required — direct SDK integration

---

## Deliverable 1: Data Model + Linear SDK Service (Backend Foundation)

### Prisma Schema Changes (`prisma/schema.prisma`)

**New enum:**
```prisma
enum IssueProvider {
  GITHUB
  LINEAR
}
```

**Extend `WorkspaceCreationSource` enum:**
```prisma
enum WorkspaceCreationSource {
  MANUAL
  RESUME_BRANCH
  GITHUB_ISSUE
  LINEAR_ISSUE    // NEW
}
```

**Add to `UserSettings` model:**
```prisma
linearApiKey    String?   // Linear API token (stored locally in SQLite)
```

**Add to `Project` model:**
```prisma
issueProvider     IssueProvider  @default(GITHUB)
linearTeamId      String?        // Selected Linear team UUID
linearTeamName    String?        // Cached display name
```

**Add to `Workspace` model:**
```prisma
linearIssueId         String?   // Linear issue UUID
linearIssueIdentifier String?   // Human-readable e.g. "ENG-123"
linearIssueUrl        String?   // URL to Linear issue
```

### New Domain: `src/backend/domains/linear/`

```
src/backend/domains/linear/
  index.ts                       # Barrel exports
  linear-client.service.ts       # Core SDK wrapper
  linear-client/
    types.ts                     # LinearIssue, LinearTeam types
    schemas.ts                   # Zod schemas
  linear-state-sync.service.ts   # Workspace lifecycle -> Linear state updates
```

**`linear-client.service.ts`** key methods:
- `setApiKey(key)` / `isConfigured()` — manage SDK client lifecycle
- `validateApiKey()` — test API call, return viewer info
- `listTeams()` — fetch accessible teams
- `listMyIssues(teamId)` — assigned to me, active cycle, `unstarted` state type
- `getIssue(issueId)` — single issue fetch
- `transitionIssueState(issueId, targetStateType)` — move issue to `started`/`completed`
- `findWorkflowState(teamId, stateType)` — resolve team-specific state IDs

**Important:** Use Linear's `stateType` (`unstarted`, `started`, `completed`) for filtering and transitions, NOT state names (which are customizable per team).

### Shared Type Updates
- Add `IssueProvider` and `LINEAR_ISSUE` to `src/shared/core/enums.ts`

### Files to create/modify:
- `prisma/schema.prisma` — schema changes above
- `src/shared/core/enums.ts` — new enum values
- `src/backend/domains/linear/` — new domain (all files)
- `package.json` — add `@linear/sdk` dependency

---

## Deliverable 2: Admin Configuration UI (tRPC + Frontend)

### New tRPC Router: `src/backend/trpc/linear.trpc.ts`

```
validateApiKey  — validate a key, return viewer name
listTeams       — list teams for configured key
checkHealth     — connection status check
```

Register in `src/backend/trpc/index.ts`.

### Existing Router Updates

**`src/backend/trpc/user-settings.trpc.ts`:**
- Add `linearApiKey` to the update mutation input schema

**`src/backend/trpc/project.trpc.ts`:**
- Add `issueProvider`, `linearTeamId`, `linearTeamName` to the update mutation

**`src/backend/resource_accessors/user-settings.accessor.ts`:**
- Add `linearApiKey` to update input types

### Admin Page UI (`src/client/routes/admin-page.tsx`)

**New section: "Linear Integration"** (add between existing sections):
- Password input for API key with "Validate" button
- On validation success: show viewer name + green checkmark
- On failure: show error message
- Save via `userSettings.update({ linearApiKey })`

**Extend `ProjectFactoryConfigCard`** (lines 41-143):
- Add "Issue Provider" dropdown: GitHub Issues (default) / Linear Issues
- When "Linear Issues" selected + valid API key: show team dropdown (populated from `linear.listTeams`)
- When "Linear Issues" selected + no valid key: show warning linking to Linear Integration section
- Save via `project.update({ issueProvider, linearTeamId, linearTeamName })`

### Files to create/modify:
- `src/backend/trpc/linear.trpc.ts` — new router
- `src/backend/trpc/index.ts` — register linear router
- `src/backend/trpc/user-settings.trpc.ts` — add linearApiKey
- `src/backend/trpc/project.trpc.ts` — add issueProvider, linearTeamId, linearTeamName
- `src/backend/resource_accessors/user-settings.accessor.ts` — add linearApiKey
- `src/client/routes/admin-page.tsx` — new Linear section + extend project config card

---

## Deliverable 3: Kanban Board — Linear Issues Display

### tRPC Endpoints

**Add to `src/backend/trpc/linear.trpc.ts`:**
```
listIssuesForProject  — fetch issues for a project's configured team
getIssue              — single issue detail fetch
```

### Kanban Context Changes (`src/frontend/components/kanban/kanban-context.tsx`)

**New normalized issue type** (replace `GitHubIssue` as the context's issue type):
```ts
interface KanbanIssue {
  id: string;              // GitHub: `${number}`, Linear: UUID
  displayId: string;       // GitHub: "#123", Linear: "ENG-123"
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: string;
  provider: 'github' | 'linear';
  // Provider-specific fields for workspace creation
  githubIssueNumber?: number;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}
```

**`KanbanProvider` changes:**
- Accept `issueProvider` prop (from project data — need to pass through from `WorkspacesBoardView`)
- Conditionally query `trpc.github.listIssuesForProject` OR `trpc.linear.listIssuesForProject`
- Normalize results into `KanbanIssue[]`
- Update dedup filter: check `githubIssueNumber` OR `linearIssueId` depending on provider
- Add Linear connection error state to context

### Kanban Column Label (`src/frontend/components/kanban/kanban-column.tsx`)

Change `KANBAN_COLUMNS` from a constant to a function:
```ts
function getKanbanColumns(issueProvider: IssueProvider): ColumnConfig[] {
  return [
    {
      id: 'ISSUES',
      label: issueProvider === 'LINEAR' ? 'Linear Issues' : 'GitHub Issues',
      description: 'Issues assigned to you',
    },
    // ... WORKING, WAITING, DONE unchanged
  ];
}
```

### Issue Card (`src/frontend/components/kanban/issue-card.tsx`)

Refactor to accept `KanbanIssue` instead of `GitHubIssue`:
- Display `issue.displayId` instead of `#${issue.number}`
- Icon: green `CircleDot` for GitHub, different icon/color for Linear
- "Start" handler: dispatch `GITHUB_ISSUE` or `LINEAR_ISSUE` based on `issue.provider`

### Issue Details Sheet (`src/frontend/components/kanban/issue-details-sheet.tsx`)

Refactor to accept `KanbanIssue`:
- Fetch full issue from correct provider
- "Open in GitHub" becomes "Open in Linear" when applicable

### Kanban Board Error State (`src/frontend/components/kanban/kanban-board.tsx`)

In `IssuesColumn`: if `issueProvider === 'LINEAR'` and connection check fails, show:
```
Linear connection failed.
Check Admin Settings →
```

### Plumbing: Pass `issueProvider` through

`WorkspacesBoardView` already receives `projectId`. The `KanbanProvider` can either:
- Accept `issueProvider` as a prop (preferred — parent already fetches project data), OR
- Fetch project data internally via a new query

### Files to modify:
- `src/frontend/components/kanban/kanban-context.tsx` — conditional fetching, normalized type
- `src/frontend/components/kanban/kanban-column.tsx` — dynamic label
- `src/frontend/components/kanban/kanban-board.tsx` — pass issueProvider, error state
- `src/frontend/components/kanban/issue-card.tsx` — accept KanbanIssue
- `src/frontend/components/kanban/issue-details-sheet.tsx` — accept KanbanIssue
- `src/client/routes/projects/workspaces/components/workspaces-board-view.tsx` — pass issueProvider
- `src/backend/trpc/linear.trpc.ts` — add listIssuesForProject, getIssue

---

## Deliverable 4: Workspace Creation from Linear Issues

### Backend

**`src/backend/domains/workspace/lifecycle/creation.service.ts`:**

Add `LINEAR_ISSUE` to `WorkspaceCreationSource` union (line 20-45):
```ts
| {
    type: 'LINEAR_ISSUE';
    projectId: string;
    issueId: string;
    issueIdentifier: string;
    issueUrl: string;
    name?: string;
    description?: string;
    ratchetEnabled?: boolean;
  }
```

Add case in `prepareCreation` switch (after line 204):
```ts
case 'LINEAR_ISSUE': {
  return {
    preparedInput: {
      projectId: source.projectId,
      name: source.name || source.issueIdentifier,
      description: source.description,
      linearIssueId: source.issueId,
      linearIssueIdentifier: source.issueIdentifier,
      linearIssueUrl: source.issueUrl,
      creationSource: 'LINEAR_ISSUE',
      creationMetadata: {
        issueId: source.issueId,
        issueIdentifier: source.issueIdentifier,
        issueUrl: source.issueUrl,
      },
    },
  };
}
```

Update `preparedInput` type to include Linear fields (line 126-134).

**`src/backend/trpc/workspace.trpc.ts`:**

Add `LINEAR_ISSUE` variant to workspace creation Zod schema.

**`src/backend/resource_accessors/workspace.accessor.ts`:**

Add `linearIssueId`, `linearIssueIdentifier`, `linearIssueUrl` to `CreateWorkspaceInput`.

**Workspace init orchestrator** (`src/backend/orchestration/workspace-init.orchestrator.ts`):

Add `buildInitialPromptFromLinearIssue` — fetch issue body from Linear API and format as initial agent prompt (parallel to existing GitHub issue prompt builder).

### Files to modify:
- `src/backend/domains/workspace/lifecycle/creation.service.ts` — add LINEAR_ISSUE case
- `src/backend/trpc/workspace.trpc.ts` — add LINEAR_ISSUE to Zod schema
- `src/backend/resource_accessors/workspace.accessor.ts` — add Linear fields
- `src/backend/orchestration/workspace-init.orchestrator.ts` — Linear issue prompt builder

---

## Deliverable 5: Linear State Sync

### State Mapping

| Factory Factory Event | Linear State Type |
|---|---|
| Workspace created from LINEAR_ISSUE + init starts | `started` |
| PR merged (prState: MERGED) | `completed` |

### `linear-state-sync.service.ts`

```ts
class LinearStateSyncService {
  markIssueStarted(issueId: string): Promise<void>
  markIssueCompleted(issueId: string): Promise<void>
}
```

### Integration Points

1. **On workspace init** (`workspace-init.orchestrator.ts`): After workspace creation, if `linearIssueId` exists, call `markIssueStarted()` (fire-and-forget with error logging)

2. **On PR merge** (via PR snapshot service bridge): When `prState` transitions to `MERGED`, check if workspace has `linearIssueId`, call `markIssueCompleted()`

### Bridge Wiring

**`src/backend/orchestration/domain-bridges.orchestrator.ts`:** Wire linear domain bridges for workspace data access.

### Error Handling

- All Linear API calls are best-effort — failures are logged but never block workspace operations
- Retry once with backoff on transient errors, then give up

### Files to modify:
- `src/backend/domains/linear/linear-state-sync.service.ts` — implement sync service
- `src/backend/orchestration/workspace-init.orchestrator.ts` — trigger started sync
- `src/backend/orchestration/domain-bridges.orchestrator.ts` — wire bridges
- PR snapshot flow — trigger completed sync on merge

---

## Deliverable 6: Polish + Workspace Detail UI

- **Workspace detail header**: Show Linear issue link (identifier + URL) when `linearIssueIdentifier` is set (similar to existing GitHub issue link display)
- **Export data schema** (`src/shared/schemas/export-data.schema.ts`): Update to schema version with new fields
- Edge case handling: expired API key UI states, team deleted, connection errors
- Run full verification suite

---

## Verification

1. **Unit tests**: `pnpm test` — new tests for linear-client.service, linear-state-sync.service, creation service LINEAR_ISSUE case
2. **Type check**: `pnpm typecheck`
3. **Lint**: `pnpm check:fix`
4. **Manual E2E test**:
   - Set Linear API key in admin panel → validate → see viewer name
   - Configure a project to use Linear Issues → select team from dropdown
   - Navigate to Kanban board → see "Linear Issues" column with your Todo issues
   - Click "Start" on a Linear issue → workspace created → issue moves to "In Progress" in Linear
   - Complete the workspace (merge PR) → issue moves to "Done" in Linear
   - Test error states: invalid API key, no team selected, network failure
