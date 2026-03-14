export type DefaultChatQuickActionDefinition = {
  id: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
};

export const DEFAULT_CHAT_QUICK_ACTIONS: readonly DefaultChatQuickActionDefinition[] = [
  {
    id: 'create-pr',
    name: 'Create Pull Request',
    description: 'Create a pull request for the current branch',
    icon: 'git-pull-request',
    prompt:
      'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.',
  },
  {
    id: 'address-pr-comments',
    name: 'Address PR Comments',
    description: 'Fetch and address pull request comments',
    icon: 'message-square-text',
    prompt:
      'Fetch the comments on the current pull request using the GitHub CLI (gh) and address any feedback or requested changes.',
  },
  {
    id: 'simplify-code',
    name: 'Simplify Code',
    description: 'Simplify recent changes',
    icon: 'sparkles',
    prompt:
      'Use the code-simplifier agent to review and simplify the recent changes. Focus on improving clarity, consistency, and maintainability while preserving all functionality.',
  },
] as const;
