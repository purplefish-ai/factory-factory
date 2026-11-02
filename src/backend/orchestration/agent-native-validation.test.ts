import { describe, expect, it, vi } from 'vitest';
import { validateAgentExecution } from './agent-native-validation';

function fixture(
  options: {
    values?: string[];
    nativeDefault?: string;
    preference?: string | null;
    model?: string;
  } = {}
) {
  const getLaunchOptions = vi.fn(async () => ({
    provider: 'CLAUDE' as const,
    model: options.model ?? 'claude-sonnet-4-6',
    reasoning: {
      options: (options.values ?? ['low', 'high']).map((value) => ({ value, label: value })),
      selected: 'high',
      defaultValue: options.nativeDefault,
    },
    planMode: { supported: true, selected: false },
  }));
  return {
    sessionConfigService: { getLaunchOptions },
    userSettingsQueryService: {
      get: async () => ({
        defaultClaudeReasoningEffort: options.preference ?? null,
        defaultCodexReasoningEffort: null,
      }),
    },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: vi.fn(async () => ({
        provider: 'CLAUDE' as const,
        model: 'sonnet',
      })),
    },
  };
}
describe('explicit native execution preview', () => {
  it('retains alias selection and the confirmed canonical model', async () => {
    const services = fixture();
    expect(
      await validateAgentExecution(
        { version: 1, provider: 'CLAUDE', model: 'sonnet', reasoningEffort: 'low' },
        services
      )
    ).toMatchObject({
      status: 'VALIDATED',
      intent: {
        provider: 'CLAUDE',
        requestedModel: 'sonnet',
        model: 'claude-sonnet-4-6',
        reasoningEffort: 'low',
        providerIntent: 'EXPLICIT',
        modelIntent: 'EXPLICIT',
        effortIntent: 'EXPLICIT',
        effortNormalization: 'NONE',
      },
    });
    expect(services.sessionConfigService.getLaunchOptions).toHaveBeenCalledWith({
      provider: 'CLAUDE',
      model: 'sonnet',
    });
  });
  it('rejects unsupported explicit effort rather than substituting selected', async () => {
    expect(
      await validateAgentExecution(
        { version: 1, provider: 'CLAUDE', reasoningEffort: 'xhigh' },
        fixture({ nativeDefault: 'low' })
      )
    ).toMatchObject({ status: 'UNSUPPORTED', reasonCode: 'UNSUPPORTED_REASONING_EFFORT' });
  });
  it.each([
    { preference: 'xhigh', nativeDefault: 'low', expected: 'low' },
    { preference: null, nativeDefault: 'low', expected: 'low' },
    { preference: 'xhigh', nativeDefault: undefined, expected: null },
    { preference: null, values: [], nativeDefault: 'high', expected: null },
  ])(
    'deliberately normalizes inherited effort $preference to $expected',
    async ({ expected, ...options }) => {
      expect(await validateAgentExecution({ version: 1 }, fixture(options))).toMatchObject({
        status: 'VALIDATED',
        intent: {
          reasoningEffort: expected,
          effortIntent: 'INHERITED',
          effortNormalization: 'INHERITED_TO_NATIVE_DEFAULT',
        },
      });
    }
  );
  it('pins a supported inherited effort and reads the default once', async () => {
    const services = fixture({ preference: 'high', nativeDefault: 'low' });
    const read = vi.spyOn(services.userSettingsQueryService, 'get');
    expect(await validateAgentExecution({ version: 1 }, services)).toMatchObject({
      status: 'VALIDATED',
      intent: { reasoningEffort: 'high', effortNormalization: 'NONE' },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('sanitizes native failure and invalid provider output', async () => {
    const services = fixture();
    services.sessionConfigService.getLaunchOptions.mockRejectedValueOnce(
      new Error('SECRET_TOKEN native diagnostic')
    );
    const result = await validateAgentExecution({ version: 1 }, services);
    expect(result).toMatchObject({ status: 'UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    services.sessionConfigService.getLaunchOptions.mockResolvedValueOnce({
      provider: 'CODEX',
    } as never);
    expect(await validateAgentExecution({ version: 1 }, services)).toMatchObject({
      status: 'UNAVAILABLE',
    });
  });
});
