import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { MessageState, resolveSelectedModel } from '@/shared/claude';
import { resumeModesSchema } from '@/shared/schemas/persisted-stores.schema';
import { pathExists } from '../lib/file-helpers';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { chatMessageHandlerService } from './chat-message-handlers.service';
import { FactoryConfigService } from './factory-config.service';
import { gitOpsService } from './git-ops.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { RunScriptService } from './run-script.service';
import { sessionService } from './session.service';
import { startupScriptService } from './startup-script.service';
import { terminalService } from './terminal.service';
import { workspaceStateMachine } from './workspace-state-machine.service';

const logger = createLogger('worktree-lifecycle');
const workspaceInitModes = new Map<string, boolean>();
const RESUME_MODE_FILENAME = '.ff-resume-modes.json';
const RESUME_MODE_LOCK_FILENAME = '.ff-resume-modes.json.lock';
const resumeModeLocks = new Map<string, Promise<void>>();

// File-based lock configuration
const LOCK_ACQUIRE_TIMEOUT_MS = 5000; // Maximum time to wait for lock
const LOCK_RETRY_DELAY_MS = 50; // Initial retry delay
const LOCK_MAX_RETRY_DELAY_MS = 500; // Maximum retry delay
const LOCK_MAX_STALE_RETRIES = 3; // Maximum retries after removing stale locks

/**
 * Get inode from file handle, closing the handle regardless of success.
 * Returns undefined if stat fails.
 */
async function getInodeAndClose(
  fileHandle: fs.FileHandle,
  lockPath: string
): Promise<number | undefined> {
  let handleIno: number | undefined;

  try {
    const handleStat = await fileHandle.stat();
    handleIno = handleStat.ino;
  } catch (error) {
    logger.warn('Failed to stat file handle during cleanup', {
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // CRITICAL: Always close the file handle to prevent leaking file descriptors
    await fileHandle.close().catch((closeError) => {
      logger.warn('Failed to close file handle during cleanup', {
        lockPath,
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    });
  }

  return handleIno;
}

/**
 * Verify lock ownership and unlink if we own it.
 */
async function unlinkIfOwned(lockPath: string, expectedIno: number): Promise<void> {
  try {
    const pathStat = await fs.stat(lockPath);
    if (pathStat.ino === expectedIno) {
      // Same inode - this is our lock file, safe to unlink
      await fs.unlink(lockPath).catch(() => {
        // Another process may have already removed it; ignore error
      });
    } else {
      // Different inode - another process created a new lock file at this path
      logger.debug('Lock file inode changed, not unlinking (owned by another process)', {
        lockPath,
        ourIno: expectedIno,
        currentIno: pathStat.ino,
      });
    }
  } catch (statError) {
    const code = (statError as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      // Lock file already removed - this is fine
      return;
    }
    logger.warn('Failed to stat lock file during cleanup', {
      lockPath,
      error: statError instanceof Error ? statError.message : String(statError),
    });
  }
}

/**
 * Create cleanup function for file lock.
 * Verifies ownership via inode comparison before unlinking to prevent
 * deleting another process's lock file.
 */
function createLockCleanup(
  fileHandle: fs.FileHandle | undefined,
  lockPath: string
): () => Promise<void> {
  return async () => {
    if (!fileHandle) {
      return;
    }

    const handleIno = await getInodeAndClose(fileHandle, lockPath);
    if (handleIno === undefined) {
      // Couldn't get inode - can't verify ownership, don't unlink
      return;
    }

    await unlinkIfOwned(lockPath, handleIno);
  };
}

/**
 * Check if lock file is stale and remove it if so.
 * Returns true if lock was removed or doesn't exist.
 *
 * Uses inode verification to prevent TOCTOU race where another process
 * could create a new lock between our stat() and unlink() calls.
 */
async function tryRemoveStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    const lockAge = Date.now() - stats.mtimeMs;

    // If lock is not old enough, it's not stale
    if (lockAge < LOCK_ACQUIRE_TIMEOUT_MS) {
      return false;
    }

    // Lock appears stale, but we must verify ownership before removing
    const staleIno = stats.ino;

    logger.warn('Attempting to remove stale lock file', {
      lockPath,
      lockAgeMs: lockAge,
      inode: staleIno,
    });

    // Verify the lock is still the same file before unlinking (prevent TOCTOU)
    // Between our initial stat() and now, another process could have:
    // 1. Removed the stale lock
    // 2. Created a new lock at the same path (different inode)
    // We must NOT delete their new lock
    try {
      const verifyStats = await fs.stat(lockPath);
      if (verifyStats.ino !== staleIno) {
        // File changed - another process created a new lock
        logger.debug('Lock file inode changed, not removing (new lock created)', {
          lockPath,
          originalIno: staleIno,
          currentIno: verifyStats.ino,
        });
        return false;
      }

      // Same inode - still the stale lock, safe to remove
      await fs.unlink(lockPath).catch(() => {
        // Another process may have removed it between verify and unlink; ignore
      });
      return true;
    } catch (verifyError) {
      const code = (verifyError as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        // Lock file disappeared - another process cleaned it up
        return true;
      }
      // Other errors during verification - don't remove
      logger.warn('Failed to verify lock file before removal', {
        lockPath,
        error: verifyError instanceof Error ? verifyError.message : String(verifyError),
      });
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      // Lock file doesn't exist - another process cleaned it up
      return true;
    }
    // Other errors - assume lock still exists
    logger.warn('Failed to check stale lock file', {
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Handle lock acquisition after timeout by attempting to remove stale locks.
 * Returns true if should retry, false if should throw error.
 */
async function handleLockTimeout(
  lockPath: string,
  staleRetryCount: number
): Promise<{ shouldRetry: boolean; newCount: number }> {
  if (staleRetryCount >= LOCK_MAX_STALE_RETRIES) {
    return { shouldRetry: false, newCount: staleRetryCount };
  }

  const removed = await tryRemoveStaleLock(lockPath);
  if (!removed) {
    return { shouldRetry: false, newCount: staleRetryCount };
  }

  // Wait a short time before retrying to avoid tight spin loop
  await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  return { shouldRetry: true, newCount: staleRetryCount + 1 };
}

/**
 * Acquire a cross-process file lock using atomic file creation.
 * Returns a cleanup function to release the lock.
 */
async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const startTime = Date.now();
  let retryDelay = LOCK_RETRY_DELAY_MS;
  let staleRetryCount = 0;

  while (true) {
    try {
      // Try to create lock file exclusively (atomic operation)
      const fileHandle = await fs.open(lockPath, 'wx');
      return createLockCleanup(fileHandle, lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;

      // EEXIST means lock file already exists (another process holds the lock)
      if (code !== 'EEXIST') {
        // Other errors (permissions, disk full, etc.) - propagate
        throw error;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= LOCK_ACQUIRE_TIMEOUT_MS) {
        const { shouldRetry, newCount } = await handleLockTimeout(lockPath, staleRetryCount);
        staleRetryCount = newCount;
        if (shouldRetry) {
          continue;
        }
        throw new Error(
          `Failed to acquire lock after ${LOCK_ACQUIRE_TIMEOUT_MS}ms and ${staleRetryCount} stale removal attempts: ${lockPath}`
        );
      }

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, LOCK_MAX_RETRY_DELAY_MS);
    }
  }
}

async function withResumeModeLock<T>(
  worktreeBasePath: string,
  handler: () => Promise<T>
): Promise<T> {
  // First acquire in-process lock (for same-process coordination)
  const previous = resumeModeLocks.get(worktreeBasePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = previous.then(() => next);
  resumeModeLocks.set(worktreeBasePath, lock);
  await previous;

  // Then acquire cross-process file lock
  const lockPath = path.join(worktreeBasePath, RESUME_MODE_LOCK_FILENAME);
  let releaseLock: (() => Promise<void>) | undefined;

  try {
    // Ensure directory exists before creating lock file
    await fs.mkdir(worktreeBasePath, { recursive: true });
    releaseLock = await acquireFileLock(lockPath);
    return await handler();
  } finally {
    // Release file lock first
    if (releaseLock) {
      await releaseLock().catch((error) => {
        logger.warn('Error releasing file lock', {
          lockPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Then release in-process lock
    release?.();
    if (resumeModeLocks.get(worktreeBasePath) === lock) {
      resumeModeLocks.delete(worktreeBasePath);
    }
  }
}

async function readResumeModes(worktreeBasePath: string): Promise<Record<string, boolean>> {
  const filePath = path.join(worktreeBasePath, RESUME_MODE_FILENAME);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(content);
      const validated = resumeModesSchema.parse(parsed);
      return validated;
    } catch (error) {
      logger.warn('Failed to parse resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== 'ENOENT') {
      logger.warn('Failed to read resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
  }
}

async function writeResumeModes(
  worktreeBasePath: string,
  modes: Record<string, boolean>
): Promise<void> {
  await fs.mkdir(worktreeBasePath, { recursive: true });
  const targetPath = path.join(worktreeBasePath, RESUME_MODE_FILENAME);
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(modes), 'utf-8');
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {
      // Best-effort cleanup; nothing to do if the temp file is already gone
    });
    throw err;
  }
}

async function updateResumeModes(
  worktreeBasePath: string,
  handler: (modes: Record<string, boolean>) => void
): Promise<void> {
  await withResumeModeLock(worktreeBasePath, async () => {
    const modes = await readResumeModes(worktreeBasePath);
    handler(modes);
    await writeResumeModes(worktreeBasePath, modes);
  });
}

export async function setWorkspaceInitMode(
  workspaceId: string,
  useExistingBranch: boolean | undefined,
  worktreeBasePath?: string
): Promise<void> {
  if (useExistingBranch === undefined) {
    return;
  }
  workspaceInitModes.set(workspaceId, useExistingBranch);
  if (worktreeBasePath) {
    await updateResumeModes(worktreeBasePath, (modes) => {
      modes[workspaceId] = useExistingBranch;
    });
  }
}

export async function getWorkspaceInitMode(
  workspaceId: string,
  worktreeBasePath?: string
): Promise<boolean | undefined> {
  // First check in-memory cache (for backward compatibility during transition)
  if (workspaceInitModes.has(workspaceId)) {
    return workspaceInitModes.get(workspaceId);
  }

  // Then check the database creationSource field (canonical source)
  const workspace = await workspaceAccessor.findById(workspaceId);
  if (workspace?.creationSource === 'RESUME_BRANCH') {
    return true;
  }

  // Fallback to sidecar file (for workspaces created before migration)
  if (!worktreeBasePath) {
    return undefined;
  }
  const modes = await readResumeModes(worktreeBasePath);
  return modes[workspaceId];
}

async function clearWorkspaceInitMode(
  workspaceId: string,
  worktreeBasePath?: string
): Promise<void> {
  workspaceInitModes.delete(workspaceId);
  if (!worktreeBasePath) {
    return;
  }
  await updateResumeModes(worktreeBasePath, (modes) => {
    if (workspaceId in modes) {
      delete modes[workspaceId];
    }
  });
}

// Cache the authenticated GitHub username (fetched once per server lifetime)
let cachedGitHubUsername: string | null | undefined;

type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

export class WorktreePathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePathSafetyError';
  }
}

export function assertWorktreePathSafe(worktreePath: string, worktreeBasePath: string): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);
  const basePrefix = `${resolvedBasePath}${path.sep}`;

  if (resolvedWorktreePath === resolvedBasePath || !resolvedWorktreePath.startsWith(basePrefix)) {
    throw new WorktreePathSafetyError(
      'Workspace worktree path is outside the worktree base directory'
    );
  }
}

function getProjectOrThrow(workspace: WorkspaceWithProject) {
  const project = workspace.project;
  if (!(project?.repoPath && project.worktreeBasePath)) {
    throw new Error('Workspace project paths are missing');
  }
  return project;
}

async function startProvisioningOrLog(workspaceId: string): Promise<boolean> {
  try {
    await workspaceStateMachine.startProvisioning(workspaceId);
    return true;
  } catch (error) {
    logger.error('Failed to start provisioning', error as Error, { workspaceId });
    return false;
  }
}

async function getWorkspaceWithProjectOrThrow(workspaceId: string): Promise<WorkspaceWithProject> {
  const workspaceWithProject = await workspaceAccessor.findByIdWithProject(workspaceId);
  if (!workspaceWithProject?.project) {
    throw new Error('Workspace project not found');
  }
  return workspaceWithProject;
}

async function getCachedGitHubUsername(): Promise<string | null> {
  if (cachedGitHubUsername === undefined) {
    cachedGitHubUsername = await githubCLIService.getAuthenticatedUsername();
  }
  return cachedGitHubUsername ?? null;
}

async function readFactoryConfigSafe(
  worktreePath: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof FactoryConfigService.readConfig>>> {
  try {
    const factoryConfig = await FactoryConfigService.readConfig(worktreePath);
    if (factoryConfig) {
      logger.info('Found factory-factory.json config', {
        workspaceId,
        hasSetup: !!factoryConfig.scripts.setup,
        hasRun: !!factoryConfig.scripts.run,
        hasCleanup: !!factoryConfig.scripts.cleanup,
      });
    }
    return factoryConfig;
  } catch (error) {
    logger.error('Failed to parse factory-factory.json', error as Error, {
      workspaceId,
    });
    return null;
  }
}

async function runFactorySetupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string,
  factoryConfig: Awaited<ReturnType<typeof FactoryConfigService.readConfig>>
): Promise<{ ran: boolean; success: boolean }> {
  if (!factoryConfig?.scripts.setup) {
    // No script configured - not a failure, just nothing to run
    return { ran: false, success: true };
  }

  logger.info('Running setup script from factory-factory.json', { workspaceId });

  const scriptResult = await startupScriptService.runStartupScript(
    { ...workspaceWithProject, worktreePath },
    {
      ...workspaceWithProject.project,
      startupScriptCommand: factoryConfig.scripts.setup,
      startupScriptPath: null,
    }
  );

  if (!scriptResult.success) {
    const finalWorkspace = await workspaceAccessor.findById(workspaceId);
    logger.warn('Setup script from factory-factory.json failed but workspace created', {
      workspaceId,
      error: finalWorkspace?.initErrorMessage,
    });
    try {
      await sessionService.stopWorkspaceSessions(workspaceId);
    } catch (error) {
      logger.warn('Failed to stop Claude sessions after setup script failure', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ran: true, success: scriptResult.success };
}

async function runProjectStartupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string
): Promise<{ ran: boolean; success: boolean }> {
  const project = workspaceWithProject.project;
  if (!startupScriptService.hasStartupScript(project)) {
    // No script configured - not a failure, just nothing to run
    return { ran: false, success: true };
  }

  logger.info('Running startup script for workspace', {
    workspaceId,
    hasCommand: !!project.startupScriptCommand,
    hasScriptPath: !!project.startupScriptPath,
  });

  const scriptResult = await startupScriptService.runStartupScript(
    { ...workspaceWithProject, worktreePath },
    project
  );

  if (!scriptResult.success) {
    const finalWorkspace = await workspaceAccessor.findById(workspaceId);
    logger.warn('Startup script failed but workspace created', {
      workspaceId,
      error: finalWorkspace?.initErrorMessage,
    });
    try {
      await sessionService.stopWorkspaceSessions(workspaceId);
    } catch (error) {
      logger.warn('Failed to stop Claude sessions after startup script failure', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ran: true, success: scriptResult.success };
}

async function handleWorkspaceInitFailure(workspaceId: string, error: Error): Promise<void> {
  logger.error('Failed to initialize workspace worktree', error, { workspaceId });
  await workspaceStateMachine.markFailed(workspaceId, error.message);
  try {
    await sessionService.stopWorkspaceSessions(workspaceId);
  } catch (stopError) {
    logger.warn('Failed to stop Claude sessions after init failure', {
      workspaceId,
      error: stopError instanceof Error ? stopError.message : String(stopError),
    });
  }
}

async function buildInitialPromptFromGitHubIssue(workspaceId: string): Promise<string> {
  try {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspace?.githubIssueNumber) {
      return '';
    }

    const project = workspace.project;
    if (!(project?.githubOwner && project?.githubRepo)) {
      return '';
    }

    const issue = await githubCLIService.getIssue(
      project.githubOwner,
      project.githubRepo,
      workspace.githubIssueNumber
    );

    if (!issue) {
      logger.warn('Failed to fetch GitHub issue for initial prompt', {
        workspaceId,
        issueNumber: workspace.githubIssueNumber,
      });
      return '';
    }

    logger.info('Built initial prompt from GitHub issue', {
      workspaceId,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });

    return `# GitHub Issue #${issue.number}: ${issue.title}

${issue.body || '(No description provided)'}

**Issue URL**: ${issue.url}

---

## Your Task

Implement this issue following the 5-phase workflow below. Work autonomously—only ask questions if requirements are contradictory or fundamentally unclear.

**Protect your context by delegating to specialized agents:**
- Exploring unfamiliar code or architecture? Use: "Please use the Explore agent to understand [specific area]"
- Significant changes to review/simplify? Use: "Please use the code-simplifier agent to review recent changes"
- Targeted searches only? Use Grep/Glob directly

---

## Phase 1: Planning

1. **Understand requirements and find relevant code**
   - Read issue description and any linked resources
   - Search for affected files (delegate to Explore agent for broad architecture questions)
   - Identify which files need changes

2. **Create task list with TodoWrite**
   Create specific tasks for:
   - Code changes (which files and what changes?)
   - Tests to add (which test files?)
   - Verification commands (typecheck, test, build)
   - PR creation

   Update status as you work: pending → in_progress → completed

3. **Identify edge cases**
   - What could go wrong?
   - What scenarios need tests?
   - What existing patterns should you follow?

## Phase 2: Implementation

1. **Work through your TodoWrite tasks systematically**
   - Follow existing code patterns and conventions
   - Add type definitions and error handling
   - Keep commits atomic and focused
   - Update TodoWrite as you discover additional work

2. **Write tests**
   - Test new functionality and edge cases
   - Follow existing test patterns in the codebase
   - Ensure tests are focused and maintainable

3. **Commit frequently**
   - Atomic commits as you complete logical units
   - Follow project style: short, imperative, descriptive (<72 chars)
   - Reference issue number when relevant
   - Example: "Add session error handling (#${issue.number})"

## Phase 3: Verification

Run all verification checks:

\`\`\`bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
\`\`\`

Fix any failures:
- **Type errors**: Resolve without type casts when possible
- **Lint errors**: Review \`pnpm check:fix\` changes
- **Test failures**: Debug and fix before proceeding
- **Build failures**: Check for syntax errors or missing dependencies

Update TodoWrite with any additional fix tasks discovered.

## Phase 4: Final Review

1. **Review your changes**
   \`\`\`bash
   git diff origin/main
   \`\`\`

   Look for:
   - Debug logs or commented code to remove
   - Unclear variable names to improve
   - Unnecessary complexity to simplify

2. **Optional: Delegate to code-simplifier for large changes**
   If you've changed many files (8+) or added complex logic:
   - Use: "Please use the code-simplifier agent to review recent changes"
   - Re-run tests after any changes: \`pnpm test\`

3. **Ensure everything is committed**
   \`\`\`bash
   git status  # should show clean working directory
   \`\`\`

## Phase 5: Create Pull Request [REQUIRED - DO NOT SKIP]

**Pre-flight checklist before creating PR:**
- [ ] All TodoWrite tasks marked completed
- [ ] \`pnpm test\` passes
- [ ] \`pnpm typecheck\` passes
- [ ] \`pnpm build\` succeeds
- [ ] Working directory clean (\`git status\`)
- [ ] All commits have descriptive messages

**Now create the PR:**

1. **Push your branch:**
   \`\`\`bash
   git push -u origin HEAD
   \`\`\`

2. **Write PR body to /tmp/pr-body.md:**
   \`\`\`markdown
   ## Summary
   [1-3 bullets describing what this PR accomplishes]

   ## Changes
   - **[Component/Area]**: [What changed and why]
   - [Add more lines as needed]

   ## Testing
   - [x] Tests pass (\`pnpm test\`)
   - [x] Types pass (\`pnpm typecheck\`)
   - [x] Build succeeds (\`pnpm build\`)
   - [ ] Manual testing: [How to verify this change works]

   Closes #${issue.number}
   \`\`\`

3. **Create the PR:**
   \`\`\`bash
   gh pr create --title "Fix #${issue.number}: [concise description]" --body-file /tmp/pr-body.md
   \`\`\`

4. **Verify PR created successfully:**
   \`\`\`bash
   gh pr view --web
   \`\`\`

---

**You have completed this issue successfully when the PR is created and the URL is shown above.**

Start with Phase 1: Planning.`;
  } catch (error) {
    logger.warn('Error building initial prompt from GitHub issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

async function startDefaultClaudeSession(workspaceId: string): Promise<void> {
  try {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    const session = sessions[0];
    if (!session) {
      return;
    }

    // Build the initial prompt - use GitHub issue content if available
    const issuePrompt = await buildInitialPromptFromGitHubIssue(workspaceId);

    // Start the session - pass empty string to start without any initial prompt
    // (undefined would default to 'Continue with the task.')
    await sessionService.startClaudeSession(session.id, { initialPrompt: '' });

    // Route the issue prompt through the queue pipeline so runtime and replay remain consistent.
    if (issuePrompt) {
      const messageId = `auto-issue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const queued = {
        id: messageId,
        text: issuePrompt,
        timestamp: new Date().toISOString(),
        settings: {
          selectedModel: session.model,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      };
      const enqueueResult = sessionDomainService.enqueue(session.id, queued);
      if ('error' in enqueueResult) {
        logger.warn('Failed to enqueue GitHub issue prompt for auto-started session', {
          workspaceId,
          sessionId: session.id,
          error: enqueueResult.error,
        });
      } else {
        sessionDomainService.emitDelta(session.id, {
          type: 'message_state_changed',
          id: messageId,
          newState: MessageState.ACCEPTED,
          queuePosition: enqueueResult.position,
          userMessage: {
            text: queued.text,
            timestamp: queued.timestamp,
            settings: {
              ...queued.settings,
              selectedModel: resolveSelectedModel(queued.settings.selectedModel),
            },
          },
        });
        await chatMessageHandlerService.tryDispatchNextMessage(session.id);
      }
    }

    logger.debug('Auto-started default Claude session for workspace', {
      workspaceId,
      sessionId: session.id,
      hasGitHubIssuePrompt: !!issuePrompt,
    });
  } catch (error) {
    logger.warn('Failed to auto-start default Claude session for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class WorktreeLifecycleService {
  async cleanupWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeCleanupOptions
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      return;
    }

    await gitOpsService.commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
    await gitOpsService.removeWorktree(worktreePath, project);
  }

  /**
   * Handle GitHub issue after workspace archive.
   * If there's a merged PR, add a comment referencing it.
   */
  private async handleGitHubIssueOnArchive(workspace: WorkspaceWithProject): Promise<void> {
    const project = workspace.project;
    if (!(workspace.githubIssueNumber && project?.githubOwner && project?.githubRepo)) {
      return;
    }

    // Only add a comment if there's a merged PR
    if (!(workspace.prState === 'MERGED' && workspace.prUrl)) {
      return;
    }

    try {
      const comment = `This workspace has been archived. The associated PR was merged: ${workspace.prUrl}`;
      await githubCLIService.addIssueComment(
        project.githubOwner,
        project.githubRepo,
        workspace.githubIssueNumber,
        comment
      );
      logger.info('Added comment to GitHub issue on workspace archive', {
        workspaceId: workspace.id,
        issueNumber: workspace.githubIssueNumber,
        prUrl: workspace.prUrl,
      });
    } catch (error) {
      // Log but don't fail the archive if comment fails
      logger.warn('Failed to add comment to GitHub issue on workspace archive', {
        workspaceId: workspace.id,
        issueNumber: workspace.githubIssueNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async archiveWorkspace(workspace: WorkspaceWithProject, options: WorktreeCleanupOptions) {
    if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVED')) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot archive workspace from status: ${workspace.status}`,
      });
    }

    try {
      await sessionService.stopWorkspaceSessions(workspace.id);
      await RunScriptService.stopRunScript(workspace.id);
      terminalService.destroyWorkspaceTerminals(workspace.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before archive', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.cleanupWorkspaceWorktree(workspace, options);
    } catch (error) {
      logger.error('Failed to cleanup workspace worktree before archive', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const archivedWorkspace = await workspaceStateMachine.archive(workspace.id);

    // Handle associated GitHub issue after successful archive
    await this.handleGitHubIssueOnArchive(workspace);

    return archivedWorkspace;
  }

  async initializeWorkspaceWorktree(
    workspaceId: string,
    options?: { branchName?: string; useExistingBranch?: boolean }
  ): Promise<void> {
    const startedProvisioning = await startProvisioningOrLog(workspaceId);
    if (!startedProvisioning) {
      return;
    }

    let project: WorkspaceWithProject['project'] | undefined;
    let worktreeCreated = false;

    try {
      const workspaceWithProject = await getWorkspaceWithProjectOrThrow(workspaceId);
      project = workspaceWithProject.project;

      const worktreeName = `workspace-${workspaceId}`;
      const baseBranch = options?.branchName ?? project.defaultBranch;
      const useExistingBranch =
        options?.useExistingBranch ??
        (await getWorkspaceInitMode(workspaceId, project.worktreeBasePath)) ??
        false;

      await gitOpsService.ensureBaseBranchExists(project, baseBranch, project.defaultBranch);

      const worktreeInfo = useExistingBranch
        ? await gitOpsService.createWorktreeFromExistingBranch(project, worktreeName, baseBranch)
        : await (async () => {
            const gitHubUsername = await getCachedGitHubUsername();
            return gitOpsService.createWorktree(project, worktreeName, baseBranch, {
              branchPrefix: gitHubUsername ?? undefined,
              workspaceName: workspaceWithProject.name,
            });
          })();
      worktreeCreated = true;

      const factoryConfig = await readFactoryConfigSafe(worktreeInfo.worktreePath, workspaceId);

      await workspaceAccessor.update(workspaceId, {
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        // Mark branch as auto-generated when we created a new branch (not using existing)
        isAutoGeneratedBranch: !useExistingBranch,
        runScriptCommand: factoryConfig?.scripts.run ?? null,
        runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
      });

      const factorySetupResult = await runFactorySetupScriptIfConfigured(
        workspaceId,
        workspaceWithProject,
        worktreeInfo.worktreePath,
        factoryConfig
      );
      if (factorySetupResult.ran) {
        // Only start Claude session if factory setup succeeded
        if (factorySetupResult.success) {
          void startDefaultClaudeSession(workspaceId).catch((error) => {
            logger.error('Failed to start default Claude session after factory setup', {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return;
      }

      const projectSetupResult = await runProjectStartupScriptIfConfigured(
        workspaceId,
        workspaceWithProject,
        worktreeInfo.worktreePath
      );
      if (projectSetupResult.ran) {
        // Only start Claude session if project setup succeeded
        if (projectSetupResult.success) {
          void startDefaultClaudeSession(workspaceId).catch((error) => {
            logger.error('Failed to start default Claude session after project setup', {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return;
      }

      // No setup scripts ran, mark ready and start Claude session
      await workspaceStateMachine.markReady(workspaceId);
      void startDefaultClaudeSession(workspaceId).catch((error) => {
        logger.error('Failed to start default Claude session', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      await handleWorkspaceInitFailure(workspaceId, error as Error);
    } finally {
      if (worktreeCreated) {
        await clearWorkspaceInitMode(workspaceId, project?.worktreeBasePath);
      }
    }
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
