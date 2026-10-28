import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { DEFAULT_THINKING_BUDGET } from '@/shared/acp-protocol';
import type { QueuedMessage } from '@/shared/acp-protocol';

type Settings = QueuedMessage['settings'];

/** Explicit edits supersede older queued intent, independently for each setting. */
export class SessionQueuedSettings {
  private readonly edits = new WeakMap<
    AcpProcessHandle,
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
    operation: () => Promise<void>
  ): () => Promise<void> {
    if (!configId) {
      return operation;
    }
    const requestedAt = Date.now();
    const handle = this.runtime.getClient(sessionId);
    return async () => {
      await operation();
      if (!handle || this.runtime.getClient(sessionId) !== handle) {
        return;
      }
      const settings = settingsForNativeOption(handle, configId);
      const edits = this.edits.get(handle) ?? new Map();
      for (const key of Object.keys(settings) as Array<keyof Settings>) {
        edits.set(key, { requestedAt, settings: { [key]: settings[key] } });
      }
      this.edits.set(handle, edits);
    };
  }

  async configure(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>,
    supportsThinkingBudget: boolean,
    apply: {
      plan(): Promise<void>;
      thinking(budget: number | null): Promise<void>;
      model(model: string | undefined): Promise<void>;
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
    const handle = this.runtime.getClient(sessionId);
    let settings = message.settings;
    for (const edit of (handle && this.edits.get(handle))?.values() ?? []) {
      if (edit.requestedAt >= Date.parse(message.timestamp)) {
        settings = { ...settings, ...edit.settings };
      }
    }
    return settings;
  }
}

function settingsForNativeOption(handle: AcpProcessHandle, configId: string): Partial<Settings> {
  const option = handle.configOptions.find(
    (entry) => entry.id === configId || entry.category === configId
  );
  if (!option) {
    return {};
  }
  const settings: Partial<Settings> = {};
  if (option.id === 'model' || option.category === 'model') {
    settings.selectedModel = String(option.currentValue);
    const reasoning = handle.configOptions.find((entry) => entry.category === 'thought_level');
    if (reasoning) {
      settings.reasoningEffort = String(reasoning.currentValue);
    }
  } else if (option.category === 'thought_level' || option.id === 'reasoning_effort') {
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
