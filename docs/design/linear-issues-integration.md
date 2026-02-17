# Linear Issues Integration Plan

## Context

Currently, Factory Factory pulls GitHub Issues (assigned to the user) into the Kanban board's intake column. This is hardcoded as the only issue provider. The goal is to make the issue source configurable per-project, supporting both GitHub Issues (default) and Linear Issues as providers.

When Linear is selected, the app should:
- Fetch the user's Linear issues and display them in the Kanban intake column
- Allow starting workspaces from Linear issues (same as GitHub flow)
- Auto-update Linear issue status as the workspace lifecycle progresses (started -> in progress, PR merged -> done)
- Show clear error states if the Linear connection fails, with a link to admin settings

**Key decisions made:**
- Per-project Linear API key and team selection (both stored on the `Project` model)
- After entering an API key, teams are auto-populated in a dropdown for selection
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

**Add to `Project` model:**
```prisma
issueProvider     IssueProvider  @default(GITHUB)
linearApiKey      String?        // Linear API token (AES-256-GCM encrypted at rest)
linearTeamId      String?        // Selected Linear team UUID
linearTeamName    String?        // Cached display name
```

### API Key Encryption (`src/backend/services/crypto.service.ts`)

New infrastructure service for encrypting/decrypting secrets at rest:
- Uses Node.js `crypto` module with AES-256-GCM
- Encryption key is a randomly-generated 32-byte secret stored at `{baseDir}/encryption.key`
- Key file is created on first use (auto-generated, never committed)
- Encrypted values stored as `iv:authTag:ciphertext` (all base64-encoded)
- Exposes `encrypt(plaintext): string` and `decrypt(encrypted): string`

**Ownership: callers of the linear domain own all encrypt/decrypt calls.** The linear domain service is encryption-unaware — it receives plain-text API keys as parameters. This applies to both the tRPC layer and the orchestration layer.
- **On save** (`project.trpc.ts` update mutation): call `cryptoService.encrypt(apiKey)` before passing to the project accessor for persistence
- **On read from tRPC** (`linear.trpc.ts` endpoints like `listIssuesForProject`, `listTeams`, etc.): look up the project, decrypt, pass the plain key to `linearClientService` methods
- **On read from orchestration** (PR-merge sync listener, workspace init prompt builder): look up the project, decrypt, pass the plain key to `linearStateSyncService` / `linearClientService`

**Null guard**: `project.linearApiKey` is nullable (`String?`). All callers must check for null before calling `cryptoService.decrypt()`. If null, skip the Linear operation and log a warning (e.g., "Linear API key not configured for project X").

This keeps the linear domain purely focused on Linear API interactions with no infrastructure coupling beyond what it receives as arguments.

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
- `createClient(apiKey)` — create a Linear SDK client for a given API key
- `validateApiKey(apiKey)` — test API call, return viewer info
- `listTeams(apiKey)` — fetch accessible teams
- `listMyIssues(apiKey, teamId)` — fetch issues assigned to the authenticated user
- `getIssue(apiKey, issueId)` — single issue fetch
- `transitionIssueState(apiKey, issueId, targetStateType)` — move issue to `started`/`completed`
- `findWorkflowState(apiKey, teamId, stateType)` — resolve team-specific state IDs

Note: All methods accept `apiKey` because the key is per-project (fetched from the `Project` model at call time).

**Important:** Use Linear's `stateType` (`unstarted`, `started`, `completed`) for filtering and transitions, NOT state names (which are customizable per team).

### Shared Type Updates
- Add `IssueProvider` and `LINEAR_ISSUE` to `src/shared/core/enums.ts`

### Files to create/modify:
- `prisma/schema.prisma` — schema changes above
- `src/shared/core/enums.ts` — new enum values
- `src/backend/domains/linear/` — new domain (all files)
- `src/backend/services/crypto.service.ts` — AES-256-GCM encrypt/decrypt utility
- `package.json` — add `@linear/sdk` dependency

---

## Deliverable 2: Admin Configuration UI (tRPC + Frontend)

### New tRPC Router: `src/backend/trpc/linear.trpc.ts`

```
validateApiKey  — validate a provided API key, return viewer name
listTeams       — list teams for a provided API key
checkHealth     — connection status check for a project's stored key
```

Register in `src/backend/trpc/index.ts`.

### Existing Router Updates

**`src/backend/trpc/project.trpc.ts`:**
- Add `issueProvider`, `linearApiKey`, `linearTeamId`, `linearTeamName` to the update mutation

### Admin Page UI (`src/client/routes/admin-page.tsx`)

**Extend `ProjectFactoryConfigCard`** (lines 41-143):
- Add "Issue Provider" dropdown: GitHub Issues (default) / Linear Issues
- When "Linear Issues" selected: show API key input with "Validate" button
- On validation success: show viewer name + green checkmark, then show team dropdown (populated from `linear.listTeams`)
- On validation failure: show error message
- When team is selected: save via `project.update({ issueProvider, linearApiKey, linearTeamId, linearTeamName })`

### Files to create/modify:
- `src/backend/trpc/linear.trpc.ts` — new router
- `src/backend/trpc/index.ts` — register linear router
- `src/backend/trpc/project.trpc.ts` — add issueProvider, linearApiKey, linearTeamId, linearTeamName
- `src/client/routes/admin-page.tsx` — extend project config card with Linear settings

---

## Deliverable 3: Kanban Board — Linear Issues Display

### tRPC Endpoints

**Add to `src/backend/trpc/linear.trpc.ts`:**
```
listIssuesForProject  — look up project's API key + team, fetch issues
getIssue              — look up project's API key, fetch single issue detail
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
  state: string;           // GitHub: 'OPEN'/'CLOSED', Linear: state name e.g. 'Todo'
  createdAt: string;
  author: string;          // Normalized to plain string (see mapping below)
  provider: 'github' | 'linear';
  // Provider-specific fields for workspace creation
  githubIssueNumber?: number;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}
```

**Normalization mapping** (applied when converting provider responses to `KanbanIssue`):
- GitHub: `author` ← `issue.author.login` (existing type is `{ login: string }`, extract the string)
- Linear: `author` ← `issue.assignee.displayName` (or `issue.creator.displayName` as fallback)
- GitHub: `state` ← `issue.state` (already a string: `'OPEN'` / `'CLOSED'`)
- Linear: `state` ← `issue.state.name` (e.g. `'Todo'`, `'In Progress'`)

Note: Both `issue-card.tsx` and `issue-details-sheet.tsx` currently reference `issue.author.login` — these must be updated to `issue.author` (plain string) during the refactor.

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
Check project settings in Admin →
```

### Plumbing: Pass `issueProvider` as a prop

The parent page that renders `WorkspacesBoardView` already fetches the project to obtain `projectId` and `slug`. Add `issueProvider` to that same project query result and pass it down:

1. **Parent page** → passes `issueProvider` as a new prop to `WorkspacesBoardView`
2. **`WorkspacesBoardView`** → passes `issueProvider` as a new prop to `KanbanProvider`
3. **`KanbanProvider`** → uses `issueProvider` to decide which tRPC query to call and passes it through context
4. **`KanbanBoard`** → reads `issueProvider` from context to generate the correct column config

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

Add `buildInitialPromptFromLinearIssue` — the orchestrator looks up the project, checks `linearApiKey` for null, decrypts it, then passes the plain key to `linearClientService.getIssue(apiKey, issueId)` to fetch the issue body and format it as the initial agent prompt (parallel to existing GitHub issue prompt builder).

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
  /** Transitions a Linear issue to the 'started' state. Caller provides the decrypted API key. */
  markIssueStarted(apiKey: string, issueId: string): Promise<void>
  /** Transitions a Linear issue to the 'completed' state. Caller provides the decrypted API key. */
  markIssueCompleted(apiKey: string, issueId: string): Promise<void>
}
```

### Integration Points

1. **On workspace init** (`workspace-init.orchestrator.ts`): After workspace creation, if `linearIssueId` exists, the orchestrator looks up the project, checks `linearApiKey` for null, decrypts it, then calls `markIssueStarted(apiKey, linearIssueId)` (fire-and-forget with error logging)

2. **On PR merge** — subscribe to the existing `PR_SNAPSHOT_UPDATED` event from `prSnapshotService` (an `EventEmitter`). The event includes `{ workspaceId, prState, prNumber, prCiStatus, prReviewState }`. Wire a new listener in the orchestration layer (similar to how `event-collector.orchestrator.ts` subscribes at line 242):

```ts
// In a new linear-sync.orchestrator.ts or in domain-bridges.orchestrator.ts
prSnapshotService.on(PR_SNAPSHOT_UPDATED, async (event: PRSnapshotUpdatedEvent) => {
  if (event.prState !== 'MERGED') return;
  // Look up workspace + project to get linearIssueId and encrypted API key
  const workspace = await workspaceAccessor.findById(event.workspaceId);
  if (!workspace?.linearIssueId) return;
  const project = await projectAccessor.findById(workspace.projectId);
  if (!project?.linearApiKey) return;
  const apiKey = cryptoService.decrypt(project.linearApiKey);
  await linearStateSyncService.markIssueCompleted(apiKey, workspace.linearIssueId);
});
```

Note: `prSnapshotService` lives in the `github` domain and is already consumed by orchestration-layer listeners. This follows the same cross-domain event pattern.

### Bridge Wiring

**`src/backend/orchestration/domain-bridges.orchestrator.ts`:** Wire linear domain bridges for workspace data access and register the `PR_SNAPSHOT_UPDATED` listener for Linear state sync.

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
- **Export data schema** (`src/shared/schemas/export-data.schema.ts`): Bump to schema version 4. Add a `IssueProvider` Zod enum wrapper (following the established pattern for `WorkspaceStatus`, `PRState`, etc.). Add new fields to `exportedProjectSchema` (`issueProvider`, `linearTeamId`, `linearTeamName`) and `exportedWorkspaceSchema` (`linearIssueId`, `linearIssueIdentifier`, `linearIssueUrl`). **Exclude `linearApiKey` from exports** — API keys must never appear in database backups. On import, strip `linearApiKey` if present (defensive).
- Edge case handling: expired API key UI states, team deleted, connection errors
- Run full verification suite

---

## Verification

1. **Unit tests**: `pnpm test` — new tests for linear-client.service, linear-state-sync.service, creation service LINEAR_ISSUE case
2. **Type check**: `pnpm typecheck`
3. **Lint**: `pnpm check:fix`
4. **Manual E2E test**:
   - In admin panel, set a project's issue provider to "Linear Issues" → enter API key → validate → see viewer name
   - Select team from dropdown → save
   - Navigate to Kanban board → see "Linear Issues" column with your issues
   - Click "Start" on a Linear issue → workspace created → issue moves to "In Progress" in Linear
   - Complete the workspace (merge PR) → issue moves to "Done" in Linear
   - Test error states: invalid API key, no team selected, network failure
