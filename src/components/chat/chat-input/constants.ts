import { GitPullRequest, MessageSquareText, Sparkles } from 'lucide-react';

/**
 * Predefined quick actions that send messages to Claude.
 */
export const QUICK_ACTIONS = [
  {
    id: 'create-pr',
    label: 'Create Pull Request',
    icon: GitPullRequest,
    message:
      'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.',
  },
  {
    id: 'address-pr-comments',
    label: 'Address PR Comments',
    icon: MessageSquareText,
    message:
      'Fetch the comments on the current pull request using the GitHub CLI (gh) and address any feedback or requested changes.',
  },
  {
    id: 'simplify-code',
    label: 'Simplify Code',
    icon: Sparkles,
    message:
      'Use the code-simplifier agent to review and simplify the recent changes. Focus on improving clarity, consistency, and maintainability while preserving all functionality.',
  },
] as const;

export type QuickAction = (typeof QUICK_ACTIONS)[number];
