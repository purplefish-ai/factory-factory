# V2 Backlog & TODO List

This document tracks features and improvements that should be implemented in future versions of FactoryFactory.

## High Priority

### Multi-Project Support

**Problem**: Currently, `GIT_BASE_REPO_PATH` is an environment variable, which means FactoryFactory can only work with a single repository at a time. This is a significant limitation for users who want to manage multiple projects.

**Proposed Solution**:

Add a `Project` model to represent different repositories/projects:

```prisma
model Project {
  id                String      @id @default(cuid())
  name              String      // Human-readable name (e.g., "My API")
  slug              String      @unique // URL-friendly identifier
  repoPath          String      // Absolute path to git repository
  worktreeBasePath  String      // Where to create worktrees for this project
  defaultBranch     String      @default("main")
  githubOwner       String?     // For GitHub integration
  githubRepo        String?     // For GitHub integration
  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt

  // Relations
  epics             Epic[]

  @@index([slug])
}
```

**Required Changes**:

1. **Database Schema**:
   - Add `Project` model
   - Add `projectId` foreign key to `Epic` model
   - Migrate existing data to a default project

2. **API Updates**:
   - `POST /api/projects/create` - Create new project
   - `GET /api/projects` - List all projects
   - `GET /api/projects/:projectId` - Get project details
   - `PUT /api/projects/:projectId` - Update project
   - `DELETE /api/projects/:projectId` - Delete project (with safety checks)
   - Update `/api/tasks/create` to require project context (via epic)

3. **Worker Updates**:
   - Workers should read `repoPath` from project via epic → project relationship
   - Worktree creation should use project-specific `worktreeBasePath`
   - Git operations should use project-specific paths

4. **UI Updates**:
   - Project selector in navigation
   - Project management page
   - Epic creation should select parent project

**Benefits**:
- ✅ Support multiple repositories simultaneously
- ✅ Different teams can work on different projects
- ✅ Isolate worktrees per project
- ✅ Per-project configuration (default branch, GitHub settings, etc.)

**Migration Path**:
```typescript
// Create default project from environment variables
await prisma.project.create({
  data: {
    name: 'Default Project',
    slug: 'default',
    repoPath: process.env.GIT_BASE_REPO_PATH,
    worktreeBasePath: process.env.GIT_WORKTREE_BASE,
    defaultBranch: 'main',
  }
});

// Associate all existing epics with default project
await prisma.epic.updateMany({
  data: {
    projectId: defaultProject.id,
  }
});
```

---

## Medium Priority

### Worker Status Dashboard

**Problem**: No easy way to see all active workers and their current status without using tmux or curl commands.

**Proposed Solution**:
- Add `/api/workers` endpoint to list all workers
- Add `/api/workers/:agentId/logs` to stream worker logs
- Create UI page showing:
  - Active workers
  - Recent task completions
  - Failed tasks
  - Worker resource usage

### Worker Output Parsing Improvements

**Problem**: Current tool call parsing is naive and may fail with complex Claude outputs.

**Proposed Solution**:
- Implement robust XML parser for `<tool_use>` blocks
- Handle edge cases (nested XML, malformed tags, escaped content)
- Add fallback detection patterns
- Log parsing failures for debugging

### Session Resume Testing

**Problem**: Session resume functionality (`--resume`) is implemented but not tested.

**Proposed Solution**:
- Add test scenarios for worker crashes
- Verify session resume works correctly
- Document resume behavior
- Add UI for manually triggering resume

---

## Low Priority

### Claude Model Selection Per Worker

**Problem**: All workers use the same model (from `WORKER_MODEL` env var or default).

**Proposed Solution**:
- Add `preferredModel` field to `Task` or `Epic`
- Allow users to specify model when creating tasks
- Some tasks might benefit from Opus (complex), others from Haiku (simple)

### Worker Resource Limits

**Problem**: No limits on how many workers can run simultaneously.

**Proposed Solution**:
- Add `MAX_CONCURRENT_WORKERS` setting
- Queue tasks when limit is reached
- Show queue status in dashboard

### Notification System

**Problem**: No way to get notified when workers complete tasks or encounter errors.

**Proposed Solution**:
- Add webhook support
- Slack/Discord integration
- Email notifications
- Desktop notifications

### Git Branch Naming Conventions

**Problem**: Branch names are auto-generated with task IDs (`task/task-abc123`).

**Proposed Solution**:
- Allow customizable branch naming patterns
- Support team-style naming (`<team>/<issue-number>-<slug>`)
- Validate branch names don't conflict

---

## Technical Debt

### Better Error Messages

**Problem**: Some errors are too technical for end users.

**Proposed Solution**:
- Wrap git errors with helpful context
- Suggest fixes for common issues
- Link to documentation

### Test Coverage

**Problem**: No automated tests for Phase 2 code.

**Proposed Solution**:
- Add unit tests for worker agent
- Add integration tests for full task → worker → PR flow
- Mock Claude CLI for testing
- Add CI/CD pipeline

### Logging Improvements

**Problem**: Logs are currently just console.log statements.

**Proposed Solution**:
- Use structured logging (winston, pino)
- Add log levels (debug, info, warn, error)
- Include request IDs for tracing
- Store important logs in database

### TypeScript Strictness

**Problem**: Some `any` types and loose typing in Claude CLI integration.

**Proposed Solution**:
- Enable strict mode
- Add proper types for tool call parsing
- Type tmux command outputs
- Remove `any` types

---

## Future Phases

### Phase 3: Supervisor Agent
- Coordinate multiple workers
- Review PRs
- Manage rebase cascades
- Task assignment and prioritization

### Phase 4: Advanced Git Workflows
- Stacked PRs support
- Auto-merge when approved
- Conflict resolution strategies
- Rebase automation

### Phase 6: UI/UX Polish
- Real-time worker output streaming
- Terminal component for tmux sessions
- Drag-and-drop task management
- Visual git graph

---

## Notes

- All items in this backlog should be prioritized based on user feedback
- Each item should be broken down into a detailed design doc before implementation
- Consider impact on existing functionality before making changes
- Multi-project support is highest priority as it unblocks many use cases
