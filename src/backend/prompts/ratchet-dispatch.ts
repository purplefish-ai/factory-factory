import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('ratchet-prompt');

const DISPATCH_PROMPT_PATH = resolve(
  import.meta.dirname,
  '../../..',
  'prompts/ratchet/dispatch.md'
);

const FALLBACK_TEMPLATE = `You are the autonomous Ratchet agent for this workspace.

Context:
- PR Number: {{PR_NUMBER}}
- PR URL: {{PR_URL}}

## Review Comments

{{REVIEW_COMMENTS}}

Execute autonomously in this order:
1. Merge latest main and resolve conflicts.
2. Check CI failures and fix them.
3. Address unaddressed code review comments.
4. Run build/lint/test and fix failures.
5. Push only when you made actionable CI or review fixes (not merge-only updates).
6. Comment briefly on addressed review comments and resolve them.
7. Request re-review from reviewers whose comments you addressed using \`gh pr edit {{PR_NUMBER}} --add-reviewer <login>\`.
8. CRITICAL: If you made ANY code changes in response to review comments (regardless of whether you already commented on them in a previous session), you MUST post a PR comment tagging the reviewers to request re-review. Use \`gh pr comment {{PR_NUMBER}} --body "@reviewer1 @reviewer2 please re-review"\`. This is MANDATORY even if you previously commented - new code changes always require a new re-review request.

If review feedback is non-actionable, explain why in session output and exit without code changes.
Do not push merge-only updates. If you only merged main and did not fix CI or review feedback, stop without pushing.

Do not ask for confirmation.`;

class RatchetDispatchTemplateCache {
  private cachedTemplate: string | null = null;

  getTemplate(): string {
    if (this.cachedTemplate !== null) {
      return this.cachedTemplate;
    }

    try {
      const template = readFileSync(DISPATCH_PROMPT_PATH, 'utf-8').trim();
      if (!template) {
        throw new Error('Ratchet dispatch prompt template is empty');
      }
      this.cachedTemplate = template;
      return this.cachedTemplate;
    } catch (error) {
      logger.error('Failed to load ratchet dispatch prompt template; using fallback', {
        path: DISPATCH_PROMPT_PATH,
        error: String(error),
      });
      this.cachedTemplate = FALLBACK_TEMPLATE;
      return this.cachedTemplate;
    }
  }

  clear(): void {
    this.cachedTemplate = null;
  }
}

const templateCache = new RatchetDispatchTemplateCache();

export interface ReviewCommentForPrompt {
  author: string;
  body: string;
  path: string;
  line: number | null;
  url: string;
}

function formatReviewComments(comments: ReviewCommentForPrompt[]): string {
  if (comments.length === 0) {
    return 'No review comments found.';
  }

  return comments
    .map((c) => {
      const location = c.line ? `${c.path}:${c.line}` : c.path;
      return `- **@${c.author}** on \`${location}\` ([link](${c.url})):\n  > ${c.body.replaceAll('\n', '\n  > ')}`;
    })
    .join('\n\n');
}

export function buildRatchetDispatchPrompt(
  prUrl: string,
  prNumber: number,
  reviewComments: ReviewCommentForPrompt[] = []
): string {
  const comments = formatReviewComments(reviewComments);
  return templateCache
    .getTemplate()
    .replaceAll('{{PR_URL}}', () => prUrl)
    .replaceAll('{{PR_NUMBER}}', () => String(prNumber))
    .replaceAll('{{REVIEW_COMMENTS}}', () => comments);
}

export function clearRatchetDispatchPromptCache(): void {
  templateCache.clear();
}
