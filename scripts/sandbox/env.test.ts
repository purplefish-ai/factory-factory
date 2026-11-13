import { describe, expect, it } from 'vitest';
import { buildServerEnv } from './env.mjs';
import { PLANTED_CREDENTIALS } from './test-support';

describe('server environment', () => {
  it('builds the server environment from an allowlist and sandbox paths', () => {
    const env = buildServerEnv({
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/me',
        LC_ALL: 'C',
        NODE_OPTIONS: '--inspect',
        BASE_DIR: '/home/me/factory-factory',
        DATABASE_PATH: '/home/me/factory-factory/data.db',
        FF_NPM_REGISTRY_URL: 'http://127.0.0.1:4873',
        ...PLANTED_CREDENTIALS,
      },
      baseDir: '/tmp/ff-sandbox/sb-1',
      scenario: 'slow-turn',
      nodeDir: '/opt/node/bin',
    });
    expect(env).toEqual({
      PATH: '/tmp/ff-sandbox/sb-1/bin:/opt/node/bin:/usr/bin',
      HOME: '/tmp/ff-sandbox/sb-1/home',
      LC_ALL: 'C',
      FF_NPM_REGISTRY_URL: 'http://127.0.0.1:4873',
      BASE_DIR: '/tmp/ff-sandbox/sb-1',
      WORKTREE_BASE_DIR: '/tmp/ff-sandbox/sb-1/worktrees',
      CODEX_HOME: '/tmp/ff-sandbox/sb-1/codex-home',
      CODEX_PATH: '/tmp/ff-sandbox/sb-1/bin/codex',
      CLAUDE_CONFIG_DIR: '/tmp/ff-sandbox/sb-1/claude-config',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      GIT_CONFIG_GLOBAL: '/tmp/ff-sandbox/sb-1/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      DOTENV_PATH: '/tmp/ff-sandbox/sb-1/sandbox.env',
      DOTENV_QUIET: 'true',
      FF_EMIT_BACKEND_PORT: '1',
      FF_UPDATE_CHECKS_ENABLED: 'false',
      AGENT_SLACK_INTAKE_ENABLED: 'false',
      FF_SANDBOX_SCENARIO: 'slow-turn',
    });
    const bare = buildServerEnv({
      parentEnv: { FF_NPM_REGISTRY_URL: 'https://user:token@registry.example' },
      baseDir: '/t',
      scenario: 'echo',
    });
    expect(bare.FF_SANDBOX_SCENARIO).toBe('echo');
    expect('FF_NPM_REGISTRY_URL' in bare).toBe(false);
  });
});
