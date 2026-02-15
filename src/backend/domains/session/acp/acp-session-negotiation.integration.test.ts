import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpRuntimeManager } from './acp-runtime-manager';
import type { AcpClientOptions } from './types';

type SessionFixture = {
  sessionId: string;
  configOptions?: Array<{
    id: string;
    name: string;
    type: 'select';
    category: string;
    currentValue: string;
    options: Array<{ value: string; name: string; description?: string }>;
  }>;
  models?: {
    availableModels: Array<{ modelId: string; name: string }>;
    currentModelId: string;
  };
  modes?: {
    availableModes: Array<{ id: string; name: string }>;
    currentModeId: string;
  };
};

const CLAUDE_SESSION_FIXTURE: SessionFixture = {
  sessionId: 'claude-session-001',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'default',
      options: [
        {
          value: 'default',
          name: 'Default (recommended)',
          description: 'Opus 4.6 · best for complex tasks',
        },
        { value: 'sonnet', name: 'Sonnet 4.5' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ],
};

const CODEX_SESSION_FIXTURE: SessionFixture = {
  sessionId: 'codex-session-001',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'gpt-5-codex',
      options: [
        { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
        { value: 'gpt-5-codex-mini', name: 'GPT-5 Codex Mini' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'code',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'code', name: 'Code' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      type: 'select',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
  modes: {
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'code', name: 'Code' },
    ],
    currentModeId: 'code',
  },
};

function createFakeAcpBinary(tempDir: string, fileName: string, fixture: SessionFixture): string {
  const binaryPath = join(tempDir, fileName);
  const script = `#!/usr/bin/env node
const sessionFixture = ${JSON.stringify(fixture)};

let buffer = '';

function sendResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\\n');

  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf('\\n');

    if (!line) {
      continue;
    }

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof request?.id === 'undefined' || typeof request?.method !== 'string') {
      continue;
    }

    switch (request.method) {
      case 'initialize':
        sendResult(request.id, {
          protocolVersion: request.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'fake-acp-adapter', version: '0.0.1' },
        });
        break;

      case 'session/new':
        sendResult(request.id, sessionFixture);
        break;

      case 'session/load':
        sendResult(request.id, sessionFixture);
        break;

      case 'session/set_config_option':
        sendResult(request.id, { configOptions: sessionFixture.configOptions });
        break;

      default:
        sendError(request.id, -32601, 'Method not found');
        break;
    }
  }
});
`;

  writeFileSync(binaryPath, script, { mode: 0o755 });
  return binaryPath;
}

function defaultContext() {
  return { workspaceId: 'workspace-1', workingDir: process.cwd() };
}

function getOptionValues(option: { options?: unknown[] } | undefined): string[] {
  if (!(option && Array.isArray(option.options))) {
    return [];
  }

  return option.options.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const single = entry as { value?: string };
    if (typeof single.value === 'string') {
      return [single.value];
    }
    const group = entry as { options?: Array<{ value?: string }> };
    if (!Array.isArray(group.options)) {
      return [];
    }
    return group.options
      .map((opt) => opt.value)
      .filter((value): value is string => typeof value === 'string');
  });
}

function getOptionByValue(
  option: { options?: unknown[] } | undefined,
  value: string
): { value: string; name?: string } | null {
  if (!(option && Array.isArray(option.options))) {
    return null;
  }

  for (const entry of option.options) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const single = entry as { value?: string; name?: string };
    if (single.value === value) {
      return { value: single.value, name: single.name };
    }
    const group = entry as { options?: Array<{ value?: string; name?: string }> };
    if (!Array.isArray(group.options)) {
      continue;
    }
    const nested = group.options.find((nestedEntry) => nestedEntry.value === value);
    if (nested) {
      return { value: nested.value ?? value, name: nested.name };
    }
  }

  return null;
}

describe('ACP session negotiation integration', () => {
  let manager: AcpRuntimeManager;
  let tempDir: string;

  beforeEach(() => {
    manager = new AcpRuntimeManager();
    tempDir = mkdtempSync(join(tmpdir(), 'ff-acp-negotiation-'));
  });

  afterEach(async () => {
    await manager.stopAllClients();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('negotiates initial CLAUDE session config options and modes', async () => {
    const binaryPath = createFakeAcpBinary(tempDir, 'claude-acp-stub', CLAUDE_SESSION_FIXTURE);

    const options: AcpClientOptions = {
      provider: 'CLAUDE',
      sessionId: 'session-claude-1',
      workingDir: process.cwd(),
      adapterBinaryPath: binaryPath,
    };

    const handle = await manager.getOrCreateClient(
      'session-claude-1',
      options,
      {},
      defaultContext()
    );

    expect(handle.providerSessionId).toBe(CLAUDE_SESSION_FIXTURE.sessionId);

    const modelOption = handle.configOptions.find((option) => option.category === 'model');
    const modeOption = handle.configOptions.find((option) => option.category === 'mode');

    expect(getOptionValues(modelOption)).toEqual(expect.arrayContaining(['default', 'sonnet']));
    expect(getOptionValues(modeOption)).toEqual(expect.arrayContaining(['default', 'plan']));
    expect(handle.configOptions.length).toBe(2);

    const defaultModel = getOptionByValue(modelOption, 'default');
    expect(defaultModel).toEqual({ value: 'default', name: 'Opus 4.6' });
  });

  it('negotiates initial CODEX session config options and modes', async () => {
    const binaryPath = createFakeAcpBinary(
      tempDir,
      'codex-app-server-acp-stub',
      CODEX_SESSION_FIXTURE
    );

    const options: AcpClientOptions = {
      provider: 'CODEX',
      sessionId: 'session-codex-1',
      workingDir: process.cwd(),
      adapterBinaryPath: binaryPath,
    };

    const handle = await manager.getOrCreateClient(
      'session-codex-1',
      options,
      {},
      defaultContext()
    );

    expect(handle.providerSessionId).toBe(CODEX_SESSION_FIXTURE.sessionId);

    const modelOption = handle.configOptions.find((option) => option.category === 'model');
    const modeOption = handle.configOptions.find((option) => option.category === 'mode');
    const reasoningOption = handle.configOptions.find(
      (option) => option.category === 'thought_level'
    );

    expect(getOptionValues(modelOption)).toEqual(
      expect.arrayContaining(['gpt-5-codex', 'gpt-5-codex-mini'])
    );
    expect(getOptionValues(modeOption)).toEqual(expect.arrayContaining(['ask', 'code']));
    expect(getOptionValues(reasoningOption)).toEqual(
      expect.arrayContaining(['low', 'medium', 'high'])
    );
  });
});
