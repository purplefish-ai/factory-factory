import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { restorePRResumeConfig } from './session-pr-resume-config';

function option(id: string, value: string, values: string[]): SessionConfigOption {
  return {
    id,
    name: id,
    category: id,
    type: 'select',
    currentValue: value,
    options: values.map((value) => ({ value, name: value })),
  };
}

function harness(legacyExecution = '["on-failure","workspace-write"]') {
  const session = unsafeCoerce<AgentSessionRecord>({
    provider: 'CODEX',
    providerSessionId: 'sess_original',
    providerMetadata: {
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'sess_original',
        configOptions: [
          option('mode', 'plan', ['code', 'plan']),
          option('execution_mode', legacyExecution, [legacyExecution]),
        ],
      },
    },
  });
  const handle = {
    provider: 'CODEX',
    providerSessionId: 'sess_original',
    configOptions: [
      option('mode', 'agent', ['read-only', 'workspace-write', 'agent', 'agent-full-access']),
      option('collaboration_mode', 'default', ['default', 'plan']),
    ],
    connection: {
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(
        async ({
          configId,
          value,
        }: {
          configId: string;
          value: string;
        }): Promise<{ configOptions: SessionConfigOption[] }> => ({
          configOptions: handle.configOptions.map((entry: SessionConfigOption) =>
            entry.id === configId && entry.type === 'select'
              ? { ...entry, currentValue: value }
              : entry
          ),
        })
      ),
    },
  };
  return { session, handle };
}

describe('strict PR resume configuration', () => {
  it('restores migrated access and collaboration using the upstream ID without replacing identity', async () => {
    const { session, handle } = harness();
    await restorePRResumeConfig(session, unsafeCoerce<AcpProcessHandle>(handle), vi.fn());
    expect(handle.connection.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'original',
      modeId: 'workspace-write',
    });
    expect(handle.connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'original',
      configId: 'collaboration_mode',
      value: 'plan',
    });
    expect(handle.providerSessionId).toBe('sess_original');
    expect(handle.configOptions.map((entry: SessionConfigOption) => entry.currentValue)).toEqual([
      'workspace-write',
      'plan',
    ]);
  });

  it('fails closed when the saved legacy permissions cannot be migrated', async () => {
    const { session, handle } = harness('["on-request","danger-full-access"]');
    await expect(
      restorePRResumeConfig(session, unsafeCoerce<AcpProcessHandle>(handle), vi.fn())
    ).rejects.toThrow('Missing existing ACP configuration');
    expect(handle.connection.setSessionMode).not.toHaveBeenCalled();
  });

  it('rejects an unavailable saved access value before sending a provider mutation', async () => {
    const { session, handle } = harness();
    handle.configOptions[0] = option('mode', 'agent', ['agent']);
    await expect(
      restorePRResumeConfig(session, unsafeCoerce<AcpProcessHandle>(handle), vi.fn())
    ).rejects.toThrow('unavailable');
    expect(handle.connection.setSessionMode).not.toHaveBeenCalled();
  });

  it('fails closed when the adapter does not apply the saved collaboration setting', async () => {
    const { session, handle } = harness();
    handle.connection.setSessionConfigOption.mockImplementation(async () => ({
      configOptions: handle.configOptions,
    }));
    await expect(
      restorePRResumeConfig(session, unsafeCoerce<AcpProcessHandle>(handle), vi.fn())
    ).rejects.toThrow('not applied');
  });
});
