import type { ChildProcess } from 'node:child_process';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { SUBAGENTS_CAPABILITY_META_KEY } from '@/shared/acp-protocol/subagents';
import { AcpProcessHandle } from './acp-process-handle';

function createHandle(agentCapabilities: Record<string, unknown>): AcpProcessHandle {
  return new AcpProcessHandle({
    connection: {} as ClientSideConnection,
    child: { exitCode: null, killed: false } as ChildProcess,
    provider: 'test-provider',
    providerSessionId: 'provider-session-123',
    agentCapabilities,
  });
}

describe('AcpProcessHandle.getSubagentBrowseCapability', () => {
  it('returns the negotiated version-1 sub-agent browsing capability', () => {
    const handle = createHandle({
      _meta: {
        [SUBAGENTS_CAPABILITY_META_KEY]: {
          version: 1,
          list: true,
          read: true,
          notifications: true,
        },
      },
    });

    expect(handle.getSubagentBrowseCapability()).toEqual({
      version: 1,
      list: true,
      read: true,
      notifications: true,
    });
  });

  it.each([
    ['missing metadata', {}],
    ['non-record metadata', { _meta: 'invalid' }],
    [
      'unsupported capability version',
      {
        _meta: {
          [SUBAGENTS_CAPABILITY_META_KEY]: {
            version: 2,
            list: true,
            read: true,
            notifications: true,
          },
        },
      },
    ],
    [
      'malformed capability flags',
      {
        _meta: {
          [SUBAGENTS_CAPABILITY_META_KEY]: {
            version: 1,
            list: true,
            read: false,
            notifications: true,
          },
        },
      },
    ],
  ])('returns null for %s', (_label, agentCapabilities) => {
    const handle = createHandle(agentCapabilities);

    expect(handle.getSubagentBrowseCapability()).toBeNull();
  });
});
