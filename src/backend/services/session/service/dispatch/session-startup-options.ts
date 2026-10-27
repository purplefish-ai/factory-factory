import type { SessionDispatchStartOptions } from './session-dispatch.types';

export function projectSessionStartupOptions(options: SessionDispatchStartOptions) {
  return {
    resumePolicy: options.resumePolicy,
    thinkingEnabled: options.thinkingEnabled,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  };
}
