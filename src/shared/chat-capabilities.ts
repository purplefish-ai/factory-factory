export type ChatProvider = 'CLAUDE' | 'CODEX' | 'OPENCODE';
const DEFAULT_CLAUDE_THINKING_BUDGET = 10_000;

export interface ChatModelOption {
  value: string;
  label: string;
}

export interface ChatReasoningOption {
  value: string;
  label: string;
  description?: string;
}

export interface CodexCapabilityModelInput {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
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
    reasoning: {
      enabled: false,
      options: [],
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

export function createCodexChatBarCapabilities(options?: {
  selectedModel?: string;
  selectedReasoningEffort?: string | null;
  models?: CodexCapabilityModelInput[];
}): ChatBarCapabilities {
  const modelInputs = options?.models ?? [];

  const modelOptions = modelInputs.map((model) => ({
    value: model.model,
    label: model.displayName,
  }));

  const selectedModelValue = resolveSelectedCodexModel(options?.selectedModel, modelInputs);
  if (selectedModelValue && !modelOptions.some((option) => option.value === selectedModelValue)) {
    modelOptions.unshift({ value: selectedModelValue, label: selectedModelValue });
  }

  const activeModel = modelInputs.find((model) => model.model === selectedModelValue);
  const reasoningOptions =
    activeModel?.supportedReasoningEfforts.map((effort) => ({
      value: effort.reasoningEffort,
      label: effort.reasoningEffort,
      description: effort.description,
    })) ?? [];
  const selectedReasoning = resolveSelectedReasoningEffort(
    options?.selectedReasoningEffort,
    activeModel?.defaultReasoningEffort,
    reasoningOptions
  );

  return {
    provider: 'CODEX',
    model: {
      enabled: modelOptions.length > 0,
      options: modelOptions,
      ...(selectedModelValue ? { selected: selectedModelValue } : {}),
    },
    reasoning: {
      enabled: reasoningOptions.length > 0,
      options: reasoningOptions,
      ...(selectedReasoning ? { selected: selectedReasoning } : {}),
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

function resolveSelectedCodexModel(
  selectedModel: string | undefined,
  models: CodexCapabilityModelInput[]
): string | undefined {
  if (selectedModel && selectedModel.trim().length > 0) {
    return selectedModel;
  }

  const defaultModel = models.find((model) => model.isDefault);
  if (defaultModel) {
    return defaultModel.model;
  }

  return models[0]?.model;
}

function resolveSelectedReasoningEffort(
  selectedReasoningEffort: string | null | undefined,
  defaultReasoningEffort: string | undefined,
  options: ChatReasoningOption[]
): string | undefined {
  if (options.length === 0) {
    return undefined;
  }

  const values = new Set(options.map((option) => option.value));
  if (selectedReasoningEffort && values.has(selectedReasoningEffort)) {
    return selectedReasoningEffort;
  }

  if (defaultReasoningEffort && values.has(defaultReasoningEffort)) {
    return defaultReasoningEffort;
  }

  return options[0]?.value;
}
