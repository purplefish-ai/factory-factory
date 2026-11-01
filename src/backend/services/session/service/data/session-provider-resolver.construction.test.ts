import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { SessionProvider, Workspace } from '@prisma-gen/client';
import { createSessionProviderResolverService } from './session-provider-resolver.service';

function resolver(provider: SessionProvider = 'CLAUDE') {
  const dependencies = {
    getDefaultSessionProvider: vi.fn().mockResolvedValue(provider),
    getModelDefaults: vi
      .fn()
      .mockResolvedValue({ defaultClaudeModel: 'haiku', defaultCodexModel: 'gpt-saved' }),
    findWorkspace: vi.fn().mockResolvedValue({ defaultSessionProvider: 'WORKSPACE_DEFAULT' }),
  };
  return { dependencies, service: createSessionProviderResolverService(dependencies) };
}
const input = { workspaceId: 'workspace' };

describe('constructed session provider resolver', () => {
  it('keeps independently supplied lookup functions bound to each resolver', async () => {
    const a = resolver();
    const b = resolver('CODEX');
    expect(await a.service.resolveSessionDefaults(input)).toEqual({
      provider: 'CLAUDE',
      model: 'haiku',
    });
    expect(await b.service.resolveSessionDefaults(input)).toEqual({
      provider: 'CODEX',
      model: 'gpt-saved',
    });
    expect(await a.service.resolveSessionDefaults(input)).toEqual({
      provider: 'CLAUDE',
      model: 'haiku',
    });
  });

  it('skips workspace and provider reads for an explicit provider while selecting that provider model', async () => {
    const { service, dependencies } = resolver();
    expect(await service.resolveSessionDefaults({ ...input, explicitProvider: 'CODEX' })).toEqual({
      provider: 'CODEX',
      model: 'gpt-saved',
    });
    expect(dependencies.findWorkspace).not.toHaveBeenCalled();
    expect(dependencies.getDefaultSessionProvider).not.toHaveBeenCalled();
  });

  it('uses a supplied concrete workspace without generic lookup or user provider lookup', async () => {
    const { service, dependencies } = resolver();
    expect(
      await service.resolveSessionDefaults({
        ...input,
        workspace: unsafeCoerce<Workspace>({ defaultSessionProvider: 'CODEX' }),
      })
    ).toEqual({ provider: 'CODEX', model: 'gpt-saved' });
    expect(dependencies.findWorkspace).not.toHaveBeenCalled();
    expect(dependencies.getDefaultSessionProvider).not.toHaveBeenCalled();
  });

  it('rejects a missing workspace before reading user settings', async () => {
    const { service, dependencies } = resolver();
    dependencies.findWorkspace.mockResolvedValue(null);
    await expect(service.resolveSessionDefaults(input)).rejects.toThrow(
      'Workspace not found: workspace'
    );
    expect(dependencies.getDefaultSessionProvider).not.toHaveBeenCalled();
    expect(dependencies.getModelDefaults).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'CLAUDE', configured: null, explicit: undefined, model: 'sonnet' },
    { provider: 'CLAUDE', configured: '  ', explicit: undefined, model: 'sonnet' },
    { provider: 'CLAUDE', configured: 'gpt-wrong', explicit: undefined, model: 'sonnet' },
    { provider: 'CODEX', configured: null, explicit: undefined, model: 'default' },
    { provider: 'CODEX', configured: 'haiku', explicit: undefined, model: 'default' },
    { provider: 'CLAUDE', configured: ' OPUS ', explicit: ' ', model: 'opus' },
    {
      provider: 'CODEX',
      configured: 'gpt-saved',
      explicit: ' custom-identity ',
      model: 'custom-identity',
    },
    { provider: 'CLAUDE', configured: 'haiku', explicit: ' SONNET ', model: 'sonnet' },
  ] as const)(
    'preserves model policy for $provider / $configured / $explicit',
    async ({ provider, configured, explicit, model }) => {
      const { service, dependencies } = resolver(provider);
      dependencies.getModelDefaults.mockResolvedValue({
        defaultClaudeModel: configured,
        defaultCodexModel: configured,
      });
      expect(await service.resolveSessionDefaults({ ...input, explicitModel: explicit })).toEqual({
        provider,
        model,
      });
    }
  );

  it('reads model settings even when provider and model are explicit and propagates failures', async () => {
    const { service, dependencies } = resolver();
    dependencies.getModelDefaults.mockRejectedValue(new Error('settings unavailable'));
    await expect(
      service.resolveSessionDefaults({
        ...input,
        explicitProvider: 'CLAUDE',
        explicitModel: 'haiku',
      })
    ).rejects.toThrow('settings unavailable');
  });

  it('validates explicit model compatibility during preflight without reading model defaults', async () => {
    const { service, dependencies } = resolver('CODEX');
    await expect(service.resolveProviderForWorkspaceCreation(undefined, 'haiku')).rejects.toThrow(
      'not compatible'
    );
    expect(dependencies.findWorkspace).not.toHaveBeenCalled();
    expect(dependencies.getModelDefaults).not.toHaveBeenCalled();
  });

  it('retains separate provider and model reads rather than capturing a settings snapshot', async () => {
    const { service, dependencies } = resolver();
    expect(await service.resolveProviderForWorkspaceCreation()).toBe('CLAUDE');
    dependencies.getDefaultSessionProvider.mockResolvedValue('CODEX');
    dependencies.getModelDefaults.mockResolvedValue({
      defaultClaudeModel: 'opus',
      defaultCodexModel: 'gpt-new',
    });
    expect(await service.resolveSessionDefaults(input)).toEqual({
      provider: 'CODEX',
      model: 'gpt-new',
    });
  });
});

it('resolves creation defaults before a workspace exists, using saved models and validating overrides', async () => {
  const { service, dependencies } = resolver('CODEX');
  dependencies.findWorkspace.mockRejectedValue(new Error('No workspace exists yet'));
  expect(service.resolveDefaultsForWorkspaceCreation).toBeTypeOf('function');
  expect(await service.resolveDefaultsForWorkspaceCreation()).toEqual({
    provider: 'CODEX',
    model: 'gpt-saved',
  });
  expect(await service.resolveDefaultsForWorkspaceCreation('CLAUDE')).toEqual({
    provider: 'CLAUDE',
    model: 'haiku',
  });
  expect(await service.resolveDefaultsForWorkspaceCreation('CLAUDE', 'opus')).toEqual({
    provider: 'CLAUDE',
    model: 'opus',
  });
  await expect(
    service.resolveDefaultsForWorkspaceCreation('CLAUDE', 'gpt-wrong')
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
