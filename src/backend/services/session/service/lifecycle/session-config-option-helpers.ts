import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

export type SessionProvider = 'CLAUDE' | 'CODEX';

export type CodexModelCatalogEntry = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string | null;
  }>;
};

export function getSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    if ('value' in entry && typeof entry.value === 'string') {
      return [entry];
    }
    if ('options' in entry && Array.isArray(entry.options)) {
      return entry.options.filter(
        (grouped): grouped is SessionConfigSelectOption =>
          typeof grouped === 'object' && grouped !== null && typeof grouped.value === 'string'
      );
    }
    return [];
  });
}

export function getConfigOptionValues(option: SessionConfigOption): string[] {
  return getSelectOptions(option).map((entry) => entry.value);
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readConfigOptionCurrentValue(option: SessionConfigOption | null): string | null {
  if (!option) {
    return null;
  }
  return toNonEmptyString(option.currentValue);
}

function findReasoningOptionIndex(configOptions: SessionConfigOption[]): number {
  return configOptions.findIndex(
    (option) =>
      option.id === 'reasoning_effort' ||
      option.category === 'thought_level' ||
      option.category === 'reasoning'
  );
}

function resolveCodexModelValue(
  currentModelValue: string | null,
  modelCatalog: CodexModelCatalogEntry[]
): string | null {
  if (currentModelValue && modelCatalog.some((model) => model.id === currentModelValue)) {
    return currentModelValue;
  }
  return modelCatalog.find((model) => model.isDefault)?.id ?? modelCatalog[0]?.id ?? null;
}

function resolveCodexReasoningValue(
  currentReasoningValue: string | null,
  defaultReasoningValue: string | null | undefined,
  reasoningValues: string[]
): string | null {
  const values = new Set(reasoningValues);
  if (currentReasoningValue && values.has(currentReasoningValue)) {
    return currentReasoningValue;
  }
  if (defaultReasoningValue && values.has(defaultReasoningValue)) {
    return defaultReasoningValue;
  }
  return reasoningValues[0] ?? null;
}

function upsertCodexModelOption(
  configOptions: SessionConfigOption[],
  modelCatalog: CodexModelCatalogEntry[],
  fallbackModel?: string
): string | null {
  const modelOptionIndex = configOptions.findIndex((option) => option.category === 'model');
  const existingModelOption =
    modelOptionIndex >= 0 ? (configOptions[modelOptionIndex] ?? null) : null;
  const currentModelValue =
    readConfigOptionCurrentValue(existingModelOption) ?? toNonEmptyString(fallbackModel);
  const resolvedModelValue = resolveCodexModelValue(currentModelValue, modelCatalog);
  if (!resolvedModelValue) {
    return null;
  }

  const normalizedModelOption: SessionConfigOption = {
    id: existingModelOption?.id ?? 'model',
    category: 'model',
    name: existingModelOption?.name ?? 'Model',
    type: 'select',
    currentValue: resolvedModelValue,
    options: modelCatalog.map((model) => ({
      value: model.id,
      name: model.displayName,
      ...(model.description ? { description: model.description } : {}),
    })),
  };

  if (modelOptionIndex >= 0) {
    configOptions[modelOptionIndex] = normalizedModelOption;
  } else {
    configOptions.push(normalizedModelOption);
  }

  return resolvedModelValue;
}

function upsertCodexReasoningOption(
  configOptions: SessionConfigOption[],
  modelCatalog: CodexModelCatalogEntry[],
  selectedModelId: string
): void {
  const reasoningOptionIndex = findReasoningOptionIndex(configOptions);
  const existingReasoningOption =
    reasoningOptionIndex >= 0 ? (configOptions[reasoningOptionIndex] ?? null) : null;
  const selectedModel = modelCatalog.find((model) => model.id === selectedModelId);
  const reasoningCatalog = (selectedModel?.supportedReasoningEfforts ?? []).filter(
    (entry) => entry.reasoningEffort.trim().length > 0
  );

  if (reasoningCatalog.length === 0) {
    if (reasoningOptionIndex >= 0) {
      configOptions.splice(reasoningOptionIndex, 1);
    }
    return;
  }

  const reasoningSelectOptions = reasoningCatalog.map((entry) => ({
    value: entry.reasoningEffort,
    name: entry.reasoningEffort,
    ...(entry.description ? { description: entry.description } : {}),
  }));
  const resolvedReasoningValue =
    resolveCodexReasoningValue(
      readConfigOptionCurrentValue(existingReasoningOption),
      selectedModel?.defaultReasoningEffort,
      reasoningSelectOptions.map((entry) => entry.value)
    ) ?? reasoningSelectOptions[0]?.value;

  if (!resolvedReasoningValue) {
    if (reasoningOptionIndex >= 0) {
      configOptions.splice(reasoningOptionIndex, 1);
    }
    return;
  }

  const normalizedReasoningOption: SessionConfigOption = {
    id: existingReasoningOption?.id ?? 'reasoning_effort',
    category: existingReasoningOption?.category ?? 'thought_level',
    name: existingReasoningOption?.name ?? 'Reasoning Effort',
    type: 'select',
    currentValue: resolvedReasoningValue,
    options: reasoningSelectOptions,
  };

  if (reasoningOptionIndex >= 0) {
    configOptions[reasoningOptionIndex] = normalizedReasoningOption;
  } else {
    configOptions.push(normalizedReasoningOption);
  }
}

export function buildCodexConfigOptionsWithModelCatalog(
  existingConfigOptions: SessionConfigOption[],
  modelCatalog: CodexModelCatalogEntry[],
  fallbackModel?: string
): SessionConfigOption[] {
  if (modelCatalog.length === 0) {
    return existingConfigOptions;
  }

  const nextConfigOptions = [...existingConfigOptions];
  const resolvedModelValue = upsertCodexModelOption(nextConfigOptions, modelCatalog, fallbackModel);
  if (!resolvedModelValue) {
    return existingConfigOptions;
  }

  upsertCodexReasoningOption(nextConfigOptions, modelCatalog, resolvedModelValue);
  return nextConfigOptions;
}

function buildModelOptions(
  modelOption: SessionConfigOption | undefined,
  selectedModel: string | undefined
): Array<{ value: string; label: string }> {
  if (!modelOption) {
    return selectedModel ? [{ value: selectedModel, label: selectedModel }] : [];
  }

  const byValue = new Map<string, string>();
  for (const option of getSelectOptions(modelOption)) {
    if (!byValue.has(option.value)) {
      byValue.set(option.value, option.name ?? option.value);
    }
  }
  if (selectedModel && !byValue.has(selectedModel)) {
    byValue.set(selectedModel, selectedModel);
  }

  return Array.from(byValue.entries()).map(([value, label]) => ({ value, label }));
}

export function buildCapabilitiesFromConfigOptions(
  provider: SessionProvider,
  configOptions: SessionConfigOption[],
  fallbackModel?: string
): ChatBarCapabilities {
  const modelOption = configOptions.find((option) => option.category === 'model');
  const modeOption = configOptions.find((option) => option.category === 'mode');
  const thoughtOption = configOptions.find(
    (option) =>
      option.category === 'thought_level' ||
      option.id === 'reasoning_effort' ||
      option.category === 'reasoning'
  );
  const selectedModel = modelOption?.currentValue
    ? String(modelOption.currentValue)
    : (fallbackModel ?? undefined);
  const modelOptions = buildModelOptions(modelOption, selectedModel);
  const isCodexProvider = provider === 'CODEX';
  const reasoningOptions =
    isCodexProvider && thoughtOption
      ? getSelectOptions(thoughtOption).map((option) => ({
          value: option.value,
          label: option.name ?? option.value,
          ...(option.description ? { description: option.description } : {}),
        }))
      : [];
  const reasoningValues = new Set(reasoningOptions.map((option) => option.value));
  const selectedReasoning =
    isCodexProvider &&
    thoughtOption?.currentValue &&
    typeof thoughtOption.currentValue === 'string' &&
    reasoningValues.has(thoughtOption.currentValue)
      ? thoughtOption.currentValue
      : undefined;
  const modeDescriptors = modeOption
    ? [
        ...getConfigOptionValues(modeOption),
        ...getSelectOptions(modeOption)
          .map((entry) => entry.name ?? '')
          .filter((value) => value.trim().length > 0),
      ]
    : [];
  const planModeEnabled = modeDescriptors.some((entry) => /plan/i.test(entry));

  return {
    provider,
    model: {
      enabled: modelOptions.length > 0,
      options: modelOptions,
      ...(selectedModel ? { selected: selectedModel } : {}),
    },
    reasoning: {
      enabled: reasoningOptions.length > 0,
      options: reasoningOptions,
      ...(selectedReasoning ? { selected: selectedReasoning } : {}),
    },
    thinking: {
      enabled: !isCodexProvider && !!thoughtOption,
    },
    planMode: { enabled: planModeEnabled },
    attachments: isCodexProvider
      ? { enabled: false, kinds: [] }
      : { enabled: true, kinds: ['image', 'text'] },
    slashCommands: { enabled: !isCodexProvider },
    usageStats: { enabled: false, contextWindow: false },
    rewind: { enabled: false },
  };
}
