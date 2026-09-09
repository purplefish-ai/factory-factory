import { describe, expect, it } from 'vitest';
import { toCodexMcpConfigMap } from './codex-adapter-parsing';

describe('toCodexMcpConfigMap', () => {
  it('rejects the unsupported ACP transport with an actionable protocol error', () => {
    expect(() =>
      toCodexMcpConfigMap([{ type: 'acp', name: 'tools', serverId: 'tools-1' }])
    ).toThrow('ACP MCP transport is not supported');
  });
});
