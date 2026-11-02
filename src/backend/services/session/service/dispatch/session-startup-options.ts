import type { SessionDispatchStartOptions } from './session-dispatch.types';

export function projectSessionStartupOptions(options: SessionDispatchStartOptions) {
  return {
    ...(options.assertCurrent && { assertCurrent: options.assertCurrent }),
    ...(options.assertCurrentSync && { assertCurrentSync: options.assertCurrentSync }),
    resumePolicy: options.resumePolicy,
    thinkingEnabled: options.thinkingEnabled,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  };
}
