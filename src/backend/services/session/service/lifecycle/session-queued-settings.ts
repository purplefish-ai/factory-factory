import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isReasoningConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import { getConfigOptionValues } from '@/backend/services/session/service/lifecycle/session-config-option-helpers';
import { DEFAULT_THINKING_BUDGET } from '@/shared/acp-protocol';
import type { QueuedMessage } from '@/shared/acp-protocol';

type Settings = QueuedMessage['settings'];
export type AcceptedQueuedConfig = Pick<AcpProcessHandle, 'provider' | 'configOptions'>;
type ConfigOperation = () => Promise<AcceptedQueuedConfig | undefined> | Promise<void>;

/** Explicit edits supersede older queued intent, independently for each setting. */
export class SessionQueuedSettings {
  private readonly edits = new Map<
    string,
    Map<
      keyof Settings,
      {
        requestedAt: number;
        settings: Partial<Settings>;
      }
    >
  >();

  constructor(private readonly runtime: Pick<AcpRuntimeManager, 'getClient'>) {}

  capture(
    sessionId: string,
    configId: string | undefined,
    operation: ConfigOperation
  ): () => Promise<void> {
    if (!configId) {
      return async () => {
        await operation();
      };
    }
    return this.captureEdit(sessionId, operation, (handle) =>
      settingsForNativeOption(handle, configId)
    );
  }

  captureThinking(
    sessionId: string,
    maxTokens: number | null,
    operation: () => Promise<void>
  ): () => Promise<void> {
    return this.captureEdit(sessionId, operation, (handle) => {
      if (maxTokens === null) {
        return { thinkingEnabled: false };
      }
      const option = handle.configOptions.find(isReasoningConfigOption);
      if (!option || String(option.currentValue) !== String(maxTokens)) {
        return {};
      }
      const values = getConfigOptionValues(option);
      return values.length === 0 || values.includes(String(maxTokens))
        ? { thinkingEnabled: true }
        : {};
    });
  }

  private captureEdit(
    sessionId: string,
    operation: ConfigOperation,
    readSettings: (handle: AcceptedQueuedConfig) => Partial<Settings>
  ): () => Promise<void> {
    const requestedAt = Date.now();
    const handle = this.runtime.getClient(sessionId);
    const edits = this.edits.get(sessionId) ?? new Map();
    this.edits.set(sessionId, edits);
    return async () => {
      const accepted = await operation();
      if (
        this.edits.get(sessionId) !== edits ||
        (handle && this.runtime.getClient(sessionId) !== handle)
      ) {
        return;
      }
      const config = accepted ?? handle;
      if (!config) {
        return;
      }
      const settings = readSettings(config);
      for (const key of Object.keys(settings) as Array<keyof Settings>) {
        edits.set(key, { requestedAt, settings: { [key]: settings[key] } });
      }
    };
  }

  release(sessionId: string): void {
    this.edits.delete(sessionId);
  }

  async configure(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>,
    supportsThinkingBudget: boolean,
    apply: {
      plan(): Promise<void>;
      thinking(budget: number | null): Promise<void>;
      model(model: string | undefined): Promise<unknown>;
      reasoning(effort: string): Promise<void>;
    }
  ): Promise<Settings> {
    const settings = this.resolve(sessionId, message);
    if (settings.planModeEnabled) {
      await apply.plan();
    }
    if (supportsThinkingBudget) {
      await apply.thinking(settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null);
    }
    await apply.model(settings.selectedModel ?? undefined);
    if (typeof settings.reasoningEffort === 'string') {
      await apply.reasoning(settings.reasoningEffort);
    }
    return settings;
  }

  resolve(sessionId: string, message: Pick<QueuedMessage, 'timestamp' | 'settings'>): Settings {
    let settings = message.settings;
    for (const edit of this.edits.get(sessionId)?.values() ?? []) {
      if (edit.requestedAt >= Date.parse(message.timestamp)) {
        settings = { ...settings, ...edit.settings };
      }
    }
    return settings;
  }
}

function settingsForNativeOption(
  handle: AcceptedQueuedConfig,
  configId: string
): Partial<Settings> {
  const option = handle.configOptions.find(
    (entry) =>
      entry.id === configId ||
      entry.category === configId ||
      (configId === 'thought_level' && isReasoningConfigOption(entry))
  );
  if (!option) {
    return {};
  }
  const settings: Partial<Settings> = {};
  if (option.id === 'model' || option.category === 'model') {
    settings.selectedModel = String(option.currentValue);
    const reasoning = handle.configOptions.find(isReasoningConfigOption);
    if (reasoning) {
      settings.reasoningEffort = String(reasoning.currentValue);
    }
  } else if (isReasoningConfigOption(option)) {
    settings.reasoningEffort = String(option.currentValue);
  } else if (
    (handle.provider === 'CLAUDE' && (option.id === 'mode' || option.category === 'mode')) ||
    option.id === 'collaboration_mode' ||
    option.category === 'collaboration_mode'
  ) {
    settings.planModeEnabled = option.currentValue === 'plan';
  }
  return settings;
}
