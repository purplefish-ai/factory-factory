export type ChatProvider = 'CLAUDE' | 'CODEX';
const DEFAULT_CLAUDE_THINKING_BUDGET = 10_000;

export interface ChatModelOption {
  value: string;
  label: string;
}

export interface ChatBarCapabilities {
  provider: ChatProvider;
  model: {
    enabled: boolean;
    options: ChatModelOption[];
    selected?: string;
  };
  thinking: {
    enabled: boolean;
    defaultBudget?: number;
  };
  planMode: {
    enabled: boolean;
  };
  attachments: {
    enabled: boolean;
    kinds: Array<'image' | 'text'>;
  };
  slashCommands: {
    enabled: boolean;
  };
  usageStats: {
    enabled: boolean;
    contextWindow: boolean;
  };
  rewind: {
    enabled: boolean;
  };
}

export const EMPTY_CHAT_BAR_CAPABILITIES: ChatBarCapabilities = {
  provider: 'CLAUDE',
  model: {
    enabled: true,
    options: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
    selected: 'opus',
  },
  thinking: { enabled: true, defaultBudget: DEFAULT_CLAUDE_THINKING_BUDGET },
  planMode: { enabled: true },
  attachments: { enabled: true, kinds: ['image', 'text'] },
  slashCommands: { enabled: true },
  usageStats: { enabled: true, contextWindow: true },
  rewind: { enabled: true },
};

export function createClaudeChatBarCapabilities(selectedModel?: string): ChatBarCapabilities {
  return {
    provider: 'CLAUDE',
    model: {
      enabled: true,
      options: [
        { value: 'opus', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
      ...(selectedModel ? { selected: selectedModel } : {}),
    },
    thinking: {
      enabled: true,
      defaultBudget: DEFAULT_CLAUDE_THINKING_BUDGET,
    },
    planMode: {
      enabled: true,
    },
    attachments: {
      enabled: true,
      kinds: ['image', 'text'],
    },
    slashCommands: {
      enabled: true,
    },
    usageStats: {
      enabled: true,
      contextWindow: true,
    },
    rewind: {
      enabled: true,
    },
  };
}

export function createCodexChatBarCapabilities(selectedModel?: string): ChatBarCapabilities {
  const options = selectedModel ? [{ value: selectedModel, label: selectedModel }] : [];
  return {
    provider: 'CODEX',
    model: {
      enabled: options.length > 0,
      options,
      ...(selectedModel ? { selected: selectedModel } : {}),
    },
    thinking: {
      enabled: false,
    },
    planMode: {
      enabled: true,
    },
    attachments: {
      enabled: false,
      kinds: [],
    },
    slashCommands: {
      enabled: false,
    },
    usageStats: {
      enabled: false,
      contextWindow: false,
    },
    rewind: {
      enabled: false,
    },
  };
}
