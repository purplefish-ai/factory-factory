import type { QueuedMessage } from '@/shared/acp-protocol';
import type { PromptConfigurationPermit } from '../acp/acp-prompt-configuration';
import type { SessionCallerGuard } from '../bridges';
import type { SessionConfigMutationQueue } from './session-config-mutation-queue';
import type { SessionQueuedSettings } from './session-queued-settings';

type Settings = QueuedMessage['settings'];
type Message = Pick<QueuedMessage, 'timestamp' | 'settings'>;
export interface PromptConfigurationBoundary {
  permit?: PromptConfigurationPermit;
  configure(message: Message, supportsThinking: boolean): Promise<Settings>;
}
export type PromptConfigurationOperation<T> = (boundary: PromptConfigurationBoundary) => Promise<T>;

/** Serialize desired configuration, durable claim and the entire native prompt turn. */
export class SessionPromptConfiguration {
  constructor(
    private readonly queue: SessionConfigMutationQueue,
    private readonly settings: SessionQueuedSettings,
    private readonly apply: {
      plan(id: string, guard?: SessionCallerGuard): Promise<void>;
      thinking(id: string, budget: number | null, guard?: SessionCallerGuard): Promise<void>;
      model(id: string, model: string | undefined, guard?: SessionCallerGuard): Promise<unknown>;
      reasoning(id: string, effort: string, guard?: SessionCallerGuard): Promise<void>;
    }
  ) {}

  private configure(
    id: string,
    message: Message,
    supportsThinking: boolean,
    guard?: SessionCallerGuard
  ) {
    return this.settings.configure(id, message, supportsThinking, {
      plan: () => this.apply.plan(id, guard),
      thinking: (budget) => this.apply.thinking(id, budget, guard),
      model: (model) => this.apply.model(id, model, guard),
      reasoning: (effort) => this.apply.reasoning(id, effort, guard),
    });
  }

  configureQueued(
    id: string,
    message: Message,
    supportsThinking: boolean,
    guard?: SessionCallerGuard
  ): Promise<Settings> {
    return this.queue.run(id, () => this.configure(id, message, supportsThinking, guard), guard);
  }

  run<T>(
    id: string,
    operation: PromptConfigurationOperation<T>,
    guard?: SessionCallerGuard
  ): Promise<T> {
    return this.queue.runPrompt(
      id,
      (permit) =>
        operation({
          permit,
          configure: (message, supportsThinking) =>
            this.configure(id, message, supportsThinking, guard),
        }),
      guard
    );
  }
}
