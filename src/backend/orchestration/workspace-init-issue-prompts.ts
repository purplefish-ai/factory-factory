import { FACTORY_SIGNATURE } from '@/backend/lib/constants';
import { githubCLIService } from '@/backend/services/github';
import { linearClientService } from '@/backend/services/linear';
import type { createLogger } from '@/backend/services/logger.service';
import { workspaceAccessor } from '@/backend/services/workspace';
import { getDecryptedLinearConfig } from './linear-config.helper';

type Logger = ReturnType<typeof createLogger>;

type IssuePromptParams = {
  providerLabel: string;
  issueReference: string;
  title: string;
  body: string | null | undefined;
  url: string;
  commitReference: string;
  closeReference: string;
  rawScreenshotBaseUrl: string;
};

function buildLinkedIssuePrompt(params: IssuePromptParams): string {
  return `# ${params.providerLabel} ${params.issueReference}: ${params.title}

${params.body || '(No description provided)'}

**Issue URL**: ${params.url}

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
   - Example: "Add session error handling (${params.commitReference})"

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

## Phase 4.5: Capture UI Screenshots (if applicable)

If your changes affect the UI:

1. Read \`factory-factory.json\` for the \`scripts.run\` command, pick a free port, replace \`{port}\`, and start it in the background.
2. Use \`browser_navigate\` to visit the dev server URL
3. Determine the most relevant screen showing your changes and capture a screenshot
4. Save screenshots:
   \`\`\`bash
   mkdir -p .factory-factory/screenshots
   \`\`\`
   Save with descriptive names (e.g., \`dashboard-new-widget.png\`)
5. Commit the screenshots with your changes
6. Reference them in the PR body using raw GitHub URLs:
   \`![Description](${params.rawScreenshotBaseUrl}\${branch}/.factory-factory/screenshots/filename.png)\`

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

   Closes ${params.closeReference}
   \`\`\`

3. **IMPORTANT**: Always append the following signature as the very last lines of the PR body, after a horizontal rule:
   \`\`\`
   ---
   ${FACTORY_SIGNATURE}
   \`\`\`

4. **Create the PR:**
   \`\`\`bash
   gh pr create --title "Fix ${params.closeReference}: [concise description]" --body-file /tmp/pr-body.md
   \`\`\`

4. **Verify PR created successfully:**
   \`\`\`bash
   gh pr view --web
   \`\`\`

---

**You have completed this issue successfully when the PR is created and the URL is shown above.**

Start with Phase 1: Planning.`;
}

export async function buildInitialPromptFromGitHubIssue(
  workspaceId: string,
  logger: Logger
): Promise<string> {
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

    return buildLinkedIssuePrompt({
      providerLabel: 'GitHub Issue',
      issueReference: `#${issue.number}`,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      commitReference: `#${issue.number}`,
      closeReference: `#${issue.number}`,
      rawScreenshotBaseUrl: `https://raw.githubusercontent.com/${project.githubOwner}/${project.githubRepo}/`,
    });
  } catch (error) {
    logger.warn('Error building initial prompt from GitHub issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

export async function buildInitialPromptFromLinearIssue(
  workspaceId: string,
  logger: Logger
): Promise<string> {
  try {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspace?.linearIssueId) {
      return '';
    }

    const project = workspace.project;
    const linearConfig = getDecryptedLinearConfig(project.issueTrackerConfig);
    if (!linearConfig) {
      return '';
    }

    const issue = await linearClientService.getIssue(linearConfig.apiKey, workspace.linearIssueId);
    if (!issue) {
      logger.warn('Failed to fetch Linear issue for initial prompt', {
        workspaceId,
        linearIssueId: workspace.linearIssueId,
      });
      return '';
    }

    logger.info('Built initial prompt from Linear issue', {
      workspaceId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
    });

    return buildLinkedIssuePrompt({
      providerLabel: 'Linear Issue',
      issueReference: issue.identifier,
      title: issue.title,
      body: issue.description,
      url: issue.url,
      commitReference: issue.identifier,
      closeReference: issue.identifier,
      rawScreenshotBaseUrl: `https://raw.githubusercontent.com/${project.githubOwner}/${project.githubRepo}/`,
    });
  } catch (error) {
    logger.warn('Error building initial prompt from Linear issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
