import { SessionStatus } from '@prisma-gen/client';
import { githubCLIService } from '@/backend/domains/github';
import { startupScriptService } from '@/backend/domains/run-script';
import {
  chatMessageHandlerService,
  sessionDomainService,
  sessionService,
} from '@/backend/domains/session';
import { workspaceStateMachine } from '@/backend/domains/workspace/lifecycle/state-machine.service';
import { worktreeLifecycleService } from '@/backend/domains/workspace/worktree/worktree-lifecycle.service';
import { FACTORY_SIGNATURE } from '@/backend/lib/constants';
import { claudeSessionAccessor } from '@/backend/resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { SERVICE_CACHE_TTL_MS } from '@/backend/services/constants';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { gitOpsService } from '@/backend/services/git-ops.service';
import { createLogger } from '@/backend/services/logger.service';
import { MessageState, resolveSelectedModel } from '@/shared/claude';
import type { WorkspaceWithProject } from './types';

const logger = createLogger('workspace-init-orchestrator');

// Module-level cached GitHub username (cross-domain logic: caches githubCLIService result)
let cachedGitHubUsername: {
  value: string | null;
  fetchedAtMs: number;
  expiresAtMs: number;
} | null = null;

async function getCachedGitHubUsername(): Promise<string | null> {
  const nowMs = Date.now();
  if (
    cachedGitHubUsername &&
    nowMs >= cachedGitHubUsername.fetchedAtMs &&
    nowMs < cachedGitHubUsername.expiresAtMs
  ) {
    return cachedGitHubUsername.value;
  }

  const value = await githubCLIService.getAuthenticatedUsername();
  cachedGitHubUsername = {
    value: value ?? null,
    fetchedAtMs: nowMs,
    expiresAtMs: nowMs + SERVICE_CACHE_TTL_MS.ratchetAuthenticatedUsername,
  };
  return cachedGitHubUsername.value;
}

async function startProvisioningOrLog(workspaceId: string): Promise<boolean> {
  try {
    const started = await workspaceStateMachine.startProvisioning(workspaceId);
    if (!started) {
      logger.warn('Skipping workspace initialization: retry limit exceeded', { workspaceId });
      return false;
    }
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

3. **IMPORTANT**: Always append the following signature as the very last lines of the PR body, after a horizontal rule:
   \`\`\`
   ---
   ${FACTORY_SIGNATURE}
   \`\`\`

4. **Create the PR:**
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

async function startDefaultClaudeSession(workspaceId: string): Promise<string | null> {
  try {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    const session = sessions[0];
    if (!session) {
      return null;
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
      }
    }

    // Trigger queue dispatch after init/session start so messages queued during
    // workspace provisioning are picked up immediately when dispatch is allowed.
    await chatMessageHandlerService.tryDispatchNextMessage(session.id);

    logger.debug('Auto-started default Claude session for workspace', {
      workspaceId,
      sessionId: session.id,
      hasGitHubIssuePrompt: !!issuePrompt,
    });
    return session.id;
  } catch (error) {
    logger.warn('Failed to auto-start default Claude session for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function retryQueuedDispatchAfterWorkspaceReady(
  workspaceId: string,
  startedSessionId: string | null
): Promise<void> {
  try {
    // Prefer the specific session we just started; it may now be RUNNING.
    if (startedSessionId) {
      await chatMessageHandlerService.tryDispatchNextMessage(startedSessionId);
      return;
    }

    const runningSessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, {
      status: SessionStatus.RUNNING,
      limit: 1,
    });
    const runningSession = runningSessions[0];
    if (runningSession) {
      await chatMessageHandlerService.tryDispatchNextMessage(runningSession.id);
      return;
    }

    const idleSessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    const idleSession = idleSessions[0];
    if (!idleSession) {
      return;
    }

    await chatMessageHandlerService.tryDispatchNextMessage(idleSession.id);
  } catch (error) {
    logger.warn('Failed to retry queued dispatch after workspace became ready', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Initialize a workspace worktree: creates the git worktree, runs setup/startup
 * scripts, and starts the default Claude session.
 *
 * This is an orchestration function that coordinates across multiple domains
 * (workspace, session, github, run-script).
 */
export async function initializeWorkspaceWorktree(
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
      (await worktreeLifecycleService.getInitMode(workspaceId, project.worktreeBasePath)) ??
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

    // Start Claude session eagerly - runs in parallel with setup scripts.
    // If scripts fail, stopWorkspaceSessions() in the failure handlers will clean it up.
    const claudeSessionPromise = startDefaultClaudeSession(workspaceId).catch((error) => {
      logger.error('Failed to start default Claude session', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const factorySetupResult = await runFactorySetupScriptIfConfigured(
      workspaceId,
      workspaceWithProject,
      worktreeInfo.worktreePath,
      factoryConfig
    );
    if (factorySetupResult.ran) {
      const startedSessionId = await claudeSessionPromise;
      if (factorySetupResult.success) {
        await retryQueuedDispatchAfterWorkspaceReady(workspaceId, startedSessionId);
      }
      return;
    }

    const projectSetupResult = await runProjectStartupScriptIfConfigured(
      workspaceId,
      workspaceWithProject,
      worktreeInfo.worktreePath
    );
    if (projectSetupResult.ran) {
      const startedSessionId = await claudeSessionPromise;
      if (projectSetupResult.success) {
        await retryQueuedDispatchAfterWorkspaceReady(workspaceId, startedSessionId);
      }
      return;
    }

    // No setup scripts ran, mark ready
    await workspaceStateMachine.markReady(workspaceId);
    const startedSessionId = await claudeSessionPromise;
    await retryQueuedDispatchAfterWorkspaceReady(workspaceId, startedSessionId);
  } catch (error) {
    await handleWorkspaceInitFailure(workspaceId, error as Error);
  } finally {
    if (worktreeCreated) {
      await worktreeLifecycleService.clearInitMode(workspaceId, project?.worktreeBasePath);
    }
  }
}
