import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { getBundledClaudeCommand } from './claude-cli-command';
import { getBundledCodexCommand } from './codex-cli-command';
import { getNodeExecPath } from './node-runtime';

const ORIGINAL_ENV = { ...process.env };
const MAIN_APP_BINARY = '/Applications/Factory Factory.app/Contents/MacOS/Factory Factory';

describe('configured Node exec path', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, FF_NODE_EXEC_PATH: MAIN_APP_BINARY };
    configService.reload();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });

  it('launches bundled entrypoints with the executable Electron main passed in', () => {
    expect(getNodeExecPath()).toBe(MAIN_APP_BINARY);
    expect(getBundledClaudeCommand(['--version']).command).toBe(MAIN_APP_BINARY);
    expect(getBundledCodexCommand(['--version']).command).toBe(MAIN_APP_BINARY);
  });

  it('uses the current runtime outside Electron', () => {
    Reflect.deleteProperty(process.env, 'FF_NODE_EXEC_PATH');
    configService.reload();

    expect(getBundledClaudeCommand(['--version']).command).toBe(process.execPath);
    expect(getBundledCodexCommand(['--version']).command).toBe(process.execPath);
  });
});
