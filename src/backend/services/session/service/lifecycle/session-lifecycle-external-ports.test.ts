import { describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getBackendHost: vi.fn(() => '192.0.2.10'),
    getBackendPort: vi.fn(() => 3001),
  },
}));

vi.mock('@/backend/services/server-instance.service', () => ({
  serverInstanceService: {
    getPort: vi.fn(() => 3002),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(),
  },
}));

vi.mock('./session.prompt-builder', () => ({
  sessionPromptBuilder: {},
}));

vi.mock('./session.repository', () => ({
  sessionRepository: {},
}));

import { sessionAcpEnvironment } from './session-lifecycle-external-ports';

describe('session lifecycle external ports', () => {
  it('uses the configured host and runtime-bound port for child-workspace MCP requests', () => {
    const mcpServers = sessionAcpEnvironment.getMcpServers({
      workspaceId: 'workspace-1',
      parentWorkspaceId: 'parent-workspace-1',
    });

    expect(mcpServers?.[0]?.env).toMatchObject({
      FF_API_BASE_URL: 'http://192.0.2.10:3002',
    });
  });
});
