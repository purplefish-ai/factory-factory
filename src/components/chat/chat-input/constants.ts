/**
 * Predefined quick actions that send messages to Claude.
 */
export const QUICK_ACTIONS = [
  {
    id: 'create-pr',
    name: 'Create Pull Request',
    icon: 'git-pull-request',
    message:
      'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.',
  },
  {
    id: 'address-pr-comments',
    name: 'Address PR Comments',
    icon: 'message-square-text',
    message:
      'Fetch the comments on the current pull request using the GitHub CLI (gh) and address any feedback or requested changes.',
  },
  {
    id: 'simplify-code',
    name: 'Simplify Code',
    icon: 'sparkles',
    message:
      'Use the code-simplifier agent to review and simplify the recent changes. Focus on improving clarity, consistency, and maintainability while preserving all functionality.',
  },
] as const;

export type QuickAction = (typeof QUICK_ACTIONS)[number];
