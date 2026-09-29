export type ChatProvider = 'CLAUDE' | 'CODEX';

export interface ChatModelOption {
  value: string;
  label: string;
}

export interface ChatReasoningOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChatBarCapabilities {
  provider: ChatProvider;
  model: {
    enabled: boolean;
    options: ChatModelOption[];
    selected?: string;
  };
  reasoning: {
    enabled: boolean;
    options: ChatReasoningOption[];
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
    enabled: false,
    options: [],
  },
  reasoning: {
    enabled: false,
    options: [],
  },
  thinking: { enabled: false },
  planMode: { enabled: false },
  attachments: { enabled: false, kinds: [] },
  slashCommands: { enabled: false },
  usageStats: { enabled: false, contextWindow: false },
  rewind: { enabled: false },
};

export function hasResolvedChatBarCapabilities(
  capabilities: ChatBarCapabilities | null | undefined
): capabilities is ChatBarCapabilities {
  return (
    capabilities !== undefined && capabilities !== null && !isPlaceholderCapabilities(capabilities)
  );
}

function isPlaceholderCapabilities(capabilities: ChatBarCapabilities): boolean {
  return (
    capabilities.provider === EMPTY_CHAT_BAR_CAPABILITIES.provider &&
    capabilities.model.enabled === EMPTY_CHAT_BAR_CAPABILITIES.model.enabled &&
    capabilities.model.options.length === EMPTY_CHAT_BAR_CAPABILITIES.model.options.length &&
    capabilities.model.selected === undefined &&
    capabilities.reasoning.enabled === EMPTY_CHAT_BAR_CAPABILITIES.reasoning.enabled &&
    capabilities.reasoning.options.length ===
      EMPTY_CHAT_BAR_CAPABILITIES.reasoning.options.length &&
    capabilities.reasoning.selected === undefined &&
    capabilities.thinking.enabled === EMPTY_CHAT_BAR_CAPABILITIES.thinking.enabled &&
    capabilities.thinking.defaultBudget === undefined &&
    capabilities.planMode.enabled === EMPTY_CHAT_BAR_CAPABILITIES.planMode.enabled &&
    capabilities.attachments.enabled === EMPTY_CHAT_BAR_CAPABILITIES.attachments.enabled &&
    capabilities.attachments.kinds.length ===
      EMPTY_CHAT_BAR_CAPABILITIES.attachments.kinds.length &&
    capabilities.slashCommands.enabled === EMPTY_CHAT_BAR_CAPABILITIES.slashCommands.enabled &&
    capabilities.usageStats.enabled === EMPTY_CHAT_BAR_CAPABILITIES.usageStats.enabled &&
    capabilities.usageStats.contextWindow ===
      EMPTY_CHAT_BAR_CAPABILITIES.usageStats.contextWindow &&
    capabilities.rewind.enabled === EMPTY_CHAT_BAR_CAPABILITIES.rewind.enabled
  );
}
