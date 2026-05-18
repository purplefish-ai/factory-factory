import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModelState,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('acp-session-config-options');
const REQUIRED_CONFIG_CATEGORIES = ['model', 'mode'] as const;

type SessionResultWithFallbackState = {
  configOptions?: SessionConfigOption[] | null;
  models?: SessionModelState | null;
  modes?: SessionModeState | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resolveModelFamilyName(description: string | null | undefined): string | null {
  if (!isNonEmptyString(description)) {
    return null;
  }
  const familyName = description.split('·')[0]?.trim();
  return familyName && familyName.length > 0 ? familyName : null;
}

function normalizeClaudeModelOption(option: SessionConfigSelectOption): SessionConfigSelectOption {
  if (option.value !== 'default') {
    return option;
  }
  const modelFamilyName = resolveModelFamilyName(option.description);
  if (!modelFamilyName) {
    return option;
  }
  return {
    ...option,
    name: modelFamilyName,
  };
}

function isOptionGroup(
  option: SessionConfigSelectOption | SessionConfigSelectGroup
): option is SessionConfigSelectGroup {
  return 'group' in option;
}

function isOptionGroupArray(
  options: SessionConfigOption['options']
): options is SessionConfigSelectGroup[] {
  const [firstOption] = options;
  return firstOption ? isOptionGroup(firstOption) : false;
}

function normalizeClaudeConfigOptions(configOptions: SessionConfigOption[]): SessionConfigOption[] {
  return configOptions.map((configOption) => {
    if (configOption.category !== 'model') {
      return configOption;
    }

    if (isOptionGroupArray(configOption.options)) {
      const normalizedGroups = configOption.options.map((group) => ({
        ...group,
        options: group.options.map(normalizeClaudeModelOption),
      }));

      return {
        ...configOption,
        options: normalizedGroups,
      };
    }

    const normalizedOptions = configOption.options.map(normalizeClaudeModelOption);

    return {
      ...configOption,
      options: normalizedOptions,
    };
  });
}

function normalizeSessionConfigOptions(
  provider: string,
  configOptions: SessionConfigOption[]
): SessionConfigOption[] {
  const providerNormalized =
    provider === 'CLAUDE' ? normalizeClaudeConfigOptions(configOptions) : configOptions;
  return providerNormalized.map((configOption) => {
    if (configOption.category || (configOption.id !== 'model' && configOption.id !== 'mode')) {
      return configOption;
    }
    return {
      ...configOption,
      category: configOption.id,
    };
  });
}

function resolveModelConfigOption(
  models: SessionModelState | null | undefined
): SessionConfigOption | null {
  if (!(models && Array.isArray(models.availableModels))) {
    return null;
  }

  const options = models.availableModels
    .filter((entry) => isNonEmptyString(entry.modelId))
    .map((entry) => ({
      value: entry.modelId,
      name: isNonEmptyString(entry.name) ? entry.name : entry.modelId,
      ...(isNonEmptyString(entry.description) ? { description: entry.description } : {}),
    }));
  if (options.length === 0) {
    return null;
  }

  const preferredValue = isNonEmptyString(models.currentModelId) ? models.currentModelId : null;
  const currentValue =
    (preferredValue && options.some((option) => option.value === preferredValue)
      ? preferredValue
      : options[0]?.value) ?? null;
  if (!currentValue) {
    return null;
  }

  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue,
    options,
  };
}

function resolveModeConfigOption(
  modes: SessionModeState | null | undefined
): SessionConfigOption | null {
  if (!(modes && Array.isArray(modes.availableModes))) {
    return null;
  }

  const options = modes.availableModes
    .filter((entry) => isNonEmptyString(entry.id))
    .map((entry) => ({
      value: entry.id,
      name: isNonEmptyString(entry.name) ? entry.name : entry.id,
      ...(isNonEmptyString(entry.description) ? { description: entry.description } : {}),
    }));
  if (options.length === 0) {
    return null;
  }

  const preferredValue = isNonEmptyString(modes.currentModeId) ? modes.currentModeId : null;
  const currentValue =
    (preferredValue && options.some((option) => option.value === preferredValue)
      ? preferredValue
      : options[0]?.value) ?? null;
  if (!currentValue) {
    return null;
  }

  return {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue,
    options,
  };
}

function fallbackSessionConfigOptions(
  sessionResult: Pick<SessionResultWithFallbackState, 'models' | 'modes'>
): SessionConfigOption[] {
  const fallbackOptions: SessionConfigOption[] = [];
  const modelOption = resolveModelConfigOption(sessionResult.models);
  if (modelOption) {
    fallbackOptions.push(modelOption);
  }
  const modeOption = resolveModeConfigOption(sessionResult.modes);
  if (modeOption) {
    fallbackOptions.push(modeOption);
  }
  return fallbackOptions;
}

export function requireSessionConfigOptions(
  provider: string,
  sessionSource: 'newSession' | 'loadSession' | 'setSessionConfigOption',
  sessionResult: SessionResultWithFallbackState
): SessionConfigOption[] {
  let configOptions = Array.isArray(sessionResult.configOptions) ? sessionResult.configOptions : [];

  if (sessionSource !== 'setSessionConfigOption') {
    const fallbackOptions = fallbackSessionConfigOptions(sessionResult);
    if (configOptions.length === 0 && fallbackOptions.length > 0) {
      logger.warn('ACP session response missing configOptions; deriving from models/modes', {
        provider,
        sessionSource,
      });
      configOptions = fallbackOptions;
    }
  }

  if (configOptions.length === 0) {
    throw new Error(
      `ACP ${provider} ${sessionSource} response did not include required configOptions`
    );
  }

  const normalizedConfigOptions = normalizeSessionConfigOptions(provider, configOptions);
  const missingCategories = REQUIRED_CONFIG_CATEGORIES.filter(
    (category) => !normalizedConfigOptions.some((option) => option.category === category)
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `ACP ${provider} ${sessionSource} response missing required config option categories: ${missingCategories.join(', ')}`
    );
  }

  return normalizedConfigOptions;
}
