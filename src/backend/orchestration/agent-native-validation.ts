import { z } from 'zod';
import type { SessionProviderResolverService } from '@/backend/services/session';
import type { AgentExecutionConfig } from '@/shared/agent-runtime';
import { agentNativeValidationSchema } from '@/shared/agent-validation';
import type { SessionLaunchOptions } from '@/shared/session-launch';

const nativeOptions = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  model: z.string().min(1).max(256),
  reasoning: z.object({
    options: z.array(z.object({ value: z.string().min(1).max(256) })).max(100),
    defaultValue: z.string().optional(),
  }),
});
export type AgentNativeValidationServices = {
  sessionProviderResolverService: Pick<
    SessionProviderResolverService,
    'resolveDefaultsForWorkspaceCreation'
  >;
  sessionConfigService: {
    getLaunchOptions(input: {
      provider: 'CLAUDE' | 'CODEX';
      model: string;
    }): Promise<SessionLaunchOptions>;
  };
  userSettingsQueryService: {
    get(): Promise<{
      defaultClaudeReasoningEffort: string | null;
      defaultCodexReasoningEffort: string | null;
    }>;
  };
};
/** Explicit preview only. The session capsule owns native model confirmation and account discovery. */
export async function validateAgentExecution(
  config: AgentExecutionConfig,
  services: AgentNativeValidationServices
) {
  try {
    const resolved =
      await services.sessionProviderResolverService.resolveDefaultsForWorkspaceCreation(
        config.provider,
        config.model
      );
    const settings = await services.userSettingsQueryService.get();
    const inherited =
      resolved.provider === 'CLAUDE'
        ? settings.defaultClaudeReasoningEffort
        : settings.defaultCodexReasoningEffort;
    const options = nativeOptions.parse(
      await services.sessionConfigService.getLaunchOptions(resolved)
    );
    if (options.provider !== resolved.provider) {
      throw new Error('Provider mismatch');
    }
    const values = options.reasoning.options.map((option) => option.value);
    if (config.reasoningEffort !== undefined && !values.includes(config.reasoningEffort)) {
      return agentNativeValidationSchema.parse({
        status: 'UNSUPPORTED',
        reasonCode: 'UNSUPPORTED_REASONING_EFFORT',
        explanation: 'The selected native model does not support this reasoning effort.',
      });
    }
    const requestedEffort = config.reasoningEffort ?? inherited;
    const supported = requestedEffort != null && values.includes(requestedEffort);
    const nativeDefault = options.reasoning.defaultValue;
    return agentNativeValidationSchema.parse({
      status: 'VALIDATED',
      intent: {
        version: 1,
        provider: resolved.provider,
        requestedModel: resolved.model,
        model: options.model,
        reasoningEffort: supported
          ? requestedEffort
          : nativeDefault && values.includes(nativeDefault)
            ? nativeDefault
            : null,
        providerIntent: config.provider ? 'EXPLICIT' : 'INHERITED',
        modelIntent: config.model ? 'EXPLICIT' : 'INHERITED',
        effortIntent: config.reasoningEffort !== undefined ? 'EXPLICIT' : 'INHERITED',
        effortNormalization: supported ? 'NONE' : 'INHERITED_TO_NATIVE_DEFAULT',
      },
    });
  } catch {
    return agentNativeValidationSchema.parse({
      status: 'UNAVAILABLE',
      reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
      explanation:
        'Native execution options could not be verified. Check provider access and retry validation.',
    });
  }
}
