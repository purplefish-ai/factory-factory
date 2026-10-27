import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { applyAcpStartupModel, resolveAcpModelSelection } from './acp-model-selection';
import { defaultConfigOptions } from './acp-runtime-manager.test-helpers';

function modelOptions(values: string[]): SessionConfigOption[] {
  return [
    {
      id: 'provider-model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: values[0] ?? '',
      options: values.map((value) => ({ value, name: value })),
    },
  ];
}

describe('provider model identities', () => {
  it.each(['fable', 'fable[1m]'])(
    'restores supported %s aliases and canonical identities',
    (alias) => {
      const suffix = alias.endsWith('[1m]') ? '[1m]' : '';
      const canonical = `claude-fable-5${suffix}`;
      expect(resolveAcpModelSelection('CLAUDE', modelOptions([canonical]), alias).value).toBe(
        canonical
      );
      const options = modelOptions([alias]);
      const model = options[0];
      if (model?.type === 'select') {
        model.options = [{ value: alias, name: suffix ? 'Fable 5 (1M)' : 'Fable 5' }];
      }
      expect(resolveAcpModelSelection('CLAUDE', options, canonical).value).toBe(alias);
    }
  );
  it('resolves the legacy Codex default alias to the advertised native model', () => {
    expect(resolveAcpModelSelection('CODEX', modelOptions(['gpt-6.1-sol']), 'default')).toEqual({
      configId: 'provider-model',
      value: 'gpt-6.1-sol',
    });
  });

  it('resolves a Claude family alias to a single advertised canonical identity', () => {
    expect(
      resolveAcpModelSelection('CLAUDE', modelOptions(['claude-sonnet-5']), 'sonnet').value
    ).toBe('claude-sonnet-5');
  });

  it('restores a persisted canonical Claude model through its advertised versioned alias', () => {
    const options: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [{ value: 'sonnet', name: 'Sonnet 5', description: 'Sonnet 5 · Fast' }],
      },
    ];
    expect(resolveAcpModelSelection('CLAUDE', options, 'claude-sonnet-5')).toEqual({
      configId: 'model',
      value: 'sonnet',
    });
    expect(() => resolveAcpModelSelection('CLAUDE', options, 'claude-sonnet-4-5')).toThrow(
      'Unsupported model'
    );
  });

  it('does not guess a Claude version when multiple canonical models are advertised', () => {
    expect(() =>
      resolveAcpModelSelection(
        'CLAUDE',
        modelOptions(['claude-sonnet-5', 'claude-sonnet-4-5']),
        'sonnet'
      )
    ).toThrow('Unsupported model');
  });

  it('fails startup when a provider does not confirm the requested model', async () => {
    const connection = {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: defaultConfigOptions() }),
    };
    await expect(
      applyAcpStartupModel({
        connection: unsafeCoerce(connection),
        provider: 'CLAUDE',
        providerSessionId: 'thread',
        configOptions: defaultConfigOptions(),
        model: 'opus',
      })
    ).rejects.toThrow('was not applied');
  });

  it('accepts a canonical Claude model identity confirming the selected family alias', async () => {
    const initial = defaultConfigOptions().map((option) =>
      option.id === 'model' ? { ...option, currentValue: 'opus' } : option
    );
    const confirmed = defaultConfigOptions().map((option) =>
      option.id === 'model' ? { ...option, currentValue: 'claude-sonnet-5' } : option
    );
    const connection = {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: confirmed }),
    };
    await expect(
      applyAcpStartupModel({
        connection: unsafeCoerce(connection),
        provider: 'CLAUDE',
        providerSessionId: 'thread',
        configOptions: initial,
        model: 'sonnet',
      })
    ).resolves.toEqual(confirmed);
  });

  it('rejects a different canonical version when a specific Claude version was selected', async () => {
    const options = defaultConfigOptions().map((option) =>
      option.id === 'model'
        ? { ...option, currentValue: 'opus', options: [{ value: 'sonnet', name: 'Sonnet 5' }] }
        : option
    );
    const confirmed = options.map((option) =>
      option.id === 'model' ? { ...option, currentValue: 'claude-sonnet-4-5' } : option
    );
    const connection = {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: confirmed }),
    };
    await expect(
      applyAcpStartupModel({
        connection: unsafeCoerce(connection),
        provider: 'CLAUDE',
        providerSessionId: 'thread',
        configOptions: options,
        model: 'claude-sonnet-5',
      })
    ).rejects.toThrow('was not applied');
  });
});
