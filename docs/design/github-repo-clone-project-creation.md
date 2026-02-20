# GitHub Repo Clone for Project Creation

## Problem

Currently, adding a project requires the user to have the repository already cloned locally and provide the filesystem path. This is friction for users who want to start working on a GitHub repo they haven't yet checked out.

## Goal

Allow users to create a project by providing a GitHub HTTPS URL (e.g., `https://github.com/owner/repo`). Factory Factory clones the repo to an app-managed location and proceeds with the normal project creation flow. The existing local-path approach remains fully supported.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Clone destination | App-managed: `{baseDir}/repos/{owner}/{repo}` | Simple; configurable location deferred to later |
| Auth handling | Check `gh auth status` first; show setup terminal only if auth missing | Avoids unnecessary steps for already-authenticated users |
| Private vs public | Attempt clone; if it fails with auth error, prompt for auth | Public repos skip auth entirely; private repos get a clear path |
| Clone UX | Blocking with progress indicator during project creation | Matches user expectation of "I'm setting this up now" |
| URL format | Full GitHub HTTPS URL (`https://github.com/owner/repo`) | Unambiguous; already parsed by `parseGitHubRemoteUrl` in `project.accessor.ts` |

## Current Flow (Local Path)

```
User enters repo path → debounced validation (validateRepoPath) → submit
  → tRPC project.create: validate path is git repo, derive name/slug/github info
  → projectAccessor.create: insert Project record
  → navigate to /projects/{slug}
```

Key files:
- `src/client/routes/projects/new.tsx` — project creation page (onboarding + normal views)
- `src/components/project/project-repo-form.tsx` — repo path input component
- `src/backend/trpc/project.trpc.ts` — `project.create` mutation
- `src/backend/resource_accessors/project.accessor.ts` — `validateRepoPath`, `create`
- `prisma/schema.prisma` — `Project` model

## Proposed Flow (GitHub URL)

### UI Changes

#### 1. Source selector on project creation page

Add a toggle/tab at the top of the form in `new.tsx`:

```
[Local Path]  [GitHub URL]
```

- **Local Path** tab: current `ProjectRepoForm` unchanged
- **GitHub URL** tab: new form with:
  - Text input for GitHub URL (placeholder: `https://github.com/owner/repo`)
  - Real-time URL parsing + validation (extract owner/repo, show parsed result)
  - Auth status indicator (green check or warning)
  - Startup script fields (same as current)

Both tabs share the same submit button and startup script section.

#### 2. Auth check on URL input

When the user enters a valid-looking GitHub URL:
1. Call new tRPC query `project.checkGithubAuth` → runs `gh auth status` on the server
2. Display result:
   - Authenticated: green checkmark, show authenticated user
   - Not authenticated: yellow warning + "Open Terminal to Login" button

#### 3. Setup terminal modal

When "Open Terminal to Login" is clicked:
- Open a modal with an embedded terminal (reuse xterm.js components)
- Terminal runs in a temporary working directory (e.g., `{baseDir}/tmp` or system temp)
- **Not** tied to any workspace — this is a new "setup terminal" concept
- Pre-populate terminal with hint text: "Run `gh auth login` to authenticate"
- After user closes modal, re-check auth status automatically

#### 4. Clone + create flow

On form submit with a GitHub URL:
1. Parse URL → extract `owner` and `repo`
2. Compute clone path: `{baseDir}/repos/{owner}/{repo}`
3. If path already exists and is a valid git repo, skip clone (reuse existing)
4. If path exists but is not a valid repo, return error
5. Clone with progress: `git clone {url} {clonePath}` — stream progress to UI
6. Once clone completes, proceed with existing `project.create` logic using `clonePath` as `repoPath`

The progress UI should show:
- "Cloning repository..." with a spinner
- Clone output streamed in a collapsible log area
- Error state if clone fails (auth, network, invalid URL, etc.)

### Backend Changes

#### 1. New tRPC procedures in `project.trpc.ts`

```typescript
// Check if gh CLI is authenticated
project.checkGithubAuth: publicProcedure
  .query(() => { /* run gh auth status, parse output */ })
  // Returns: { authenticated: boolean; user?: string; error?: string }

// Clone a GitHub repo and create project
project.createFromGithub: publicProcedure
  .input(z.object({
    githubUrl: z.string().url(),
    startupScriptCommand: z.string().optional(),
    startupScriptPath: z.string().optional(),
    startupScriptTimeout: z.number().min(1).max(3600).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. Parse and validate URL
    // 2. Compute clone destination
    // 3. Clone repo (or reuse existing)
    // 4. Delegate to existing project.create logic
  })
```

#### 2. Clone service (new, in `src/backend/services/`)

`src/backend/services/git-clone.service.ts`:

```typescript
class GitCloneService {
  // Compute clone destination path
  getClonePath(baseDir: string, owner: string, repo: string): string

  // Check if clone destination already exists and is valid
  checkExistingClone(clonePath: string): Promise<'valid_repo' | 'not_repo' | 'not_exists'>

  // Clone a GitHub repo, returning a stream of progress events
  clone(url: string, destination: string): Promise<{ success: boolean; error?: string }>

  // Parse a GitHub URL into owner/repo
  parseGithubUrl(url: string): { owner: string; repo: string } | null
}
```

Note: `parseGitHubRemoteUrl` in `project.accessor.ts` already handles SSH and HTTPS GitHub URL parsing. The new `parseGithubUrl` can reuse or extend this.

#### 3. Setup terminal WebSocket endpoint

New WebSocket endpoint: `/setup-terminal` (separate from `/terminal`)

- Does **not** require a workspace ID
- Uses a temporary or configurable working directory
- Simplified handler — no workspace lookup, no DB persistence
- PTY lifecycle: created on connect, destroyed on disconnect
- Reuses `node-pty` and xterm.js infrastructure from existing terminal system

This is intentionally minimal — it exists solely for pre-project auth flows.

#### 4. Config changes

Add `reposDir` to `SystemConfig` in `config.service.ts`:

```typescript
// In SystemConfig:
reposDir: string;  // Default: {baseDir}/repos

// In loadSystemConfig():
reposDir: env.REPOS_DIR ? expandEnvVars(env.REPOS_DIR) : join(baseDir, 'repos'),
```

Add `REPOS_DIR` to the env schema as an optional string.

### Database Changes

**No schema changes required.** The `Project.repoPath` field stores the clone destination path, which is identical in shape to a manually-provided path. The `githubOwner` and `githubRepo` fields are already auto-detected from the git remote.

Optionally, we could add a `creationSource` field to `Project` (similar to `Workspace.creationSource`) to track whether the project was created from a local path or GitHub clone. This is nice-to-have for analytics but not required for functionality.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid GitHub URL format | Client-side validation error before submit |
| `gh` CLI not installed | Error message: "GitHub CLI (gh) is required for cloning. Install it from https://cli.github.com" |
| Not authenticated + private repo | Clone fails → show "Authentication required" + terminal button |
| Network error during clone | Show error with retry button |
| Clone destination already exists (valid repo) | Skip clone, reuse existing, show info message |
| Clone destination exists but not a git repo | Error: "Directory exists but is not a git repository" |
| Repo doesn't exist (404) | Error from git clone, surfaced as "Repository not found" |
| Disk space issues | Git clone error surfaced directly |

## Implementation Order

1. **Backend: clone service + config** — `git-clone.service.ts`, `reposDir` config
2. **Backend: `checkGithubAuth` tRPC query** — simple `gh auth status` wrapper
3. **Backend: `createFromGithub` tRPC mutation** — clone + delegate to existing create
4. **UI: source selector tabs** — toggle between local path and GitHub URL forms
5. **UI: GitHub URL form** — input, parsing, auth status indicator
6. **Backend: setup terminal WebSocket** — minimal PTY endpoint without workspace dependency
7. **UI: setup terminal modal** — xterm.js in a modal, triggered from auth warning
8. **UI: clone progress** — streaming progress indicator during project creation

## Out of Scope (Future)

- Configurable clone destination directory
- `owner/repo` shorthand URL format
- SSH URL support
- GitHub repo search/autocomplete (requires auth first)
- Shallow clones for large repos
- Clone progress streaming via WebSocket (initial version uses blocking mutation with progress polling)
