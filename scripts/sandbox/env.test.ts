import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startEgressRecorder } from './egress.mjs';
import { buildServerEnv } from './env.mjs';
import { prepareSandbox } from './prepare.mjs';
import { PLANTED_CREDENTIALS, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

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
        HTTPS_PROXY: 'http://corp-proxy.example:8080',
        GIT_SSH_COMMAND: 'ssh -i /home/me/.ssh/id_ed25519',
        ...PLANTED_CREDENTIALS,
      },
      baseDir: '/tmp/ff-sandbox/sb-1',
      scenario: 'slow-turn',
      egressPort: 6100,
      nodeDir: '/opt/node/bin',
    });
    const proxy = 'http://127.0.0.1:6100';
    expect(env).toEqual({
      PATH: '/tmp/ff-sandbox/sb-1/bin:/opt/node/bin:/usr/bin',
      HOME: '/tmp/ff-sandbox/sb-1/home',
      LC_ALL: 'C',
      FF_NPM_REGISTRY_URL: 'http://127.0.0.1:4873',
      BASE_DIR: '/tmp/ff-sandbox/sb-1',
      FF_PROJECT_ROOT: '/tmp/ff-sandbox/sb-1',
      WORKTREE_BASE_DIR: '/tmp/ff-sandbox/sb-1/worktrees',
      CODEX_HOME: '/tmp/ff-sandbox/sb-1/codex-home',
      CODEX_PATH: '/tmp/ff-sandbox/sb-1/bin/codex',
      CLAUDE_CONFIG_DIR: '/tmp/ff-sandbox/sb-1/claude-config',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
      NODE_USE_ENV_PROXY: '1',
      ANTHROPIC_BASE_URL: proxy,
      GIT_CONFIG_GLOBAL: '/tmp/ff-sandbox/sb-1/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: "'/tmp/ff-sandbox/sb-1/bin/ssh'",
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
      egressPort: 6100,
    });
    expect(bare.FF_SANDBOX_SCENARIO).toBe('echo');
    expect('FF_NPM_REGISTRY_URL' in bare).toBe(false);
    expect(() =>
      buildServerEnv({ parentEnv: {}, baseDir: '/t', scenario: 'echo', egressPort: 0 })
    ).toThrow('egress recorder port');
  });
});

type GitResult = { code: number; stderr: string };
function git(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { env, cwd, timeout: 60_000 }, (error, _stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stderr })
    );
  });
}

describe('git in the sandbox environment', () => {
  it('reaches no remote: local paths only, the ssh shim, and the egress recorder', async () => {
    const baseDir = temporary.create('ffsb-');
    const paths = prepareSandbox(baseDir);
    const recorder = await startEgressRecorder({ logFile: paths.egressLog });
    // A program a repository's `core.sshCommand` could name instead of the shim.
    const bypass = join(baseDir, 'bypass-ssh');
    const bypassLog = join(baseDir, 'bypass-calls.log');
    writeFileSync(bypassLog, '');
    writeFileSync(bypass, `#!/bin/sh\necho "$@" >> '${bypassLog}'\nexit 1\n`);
    chmodSync(bypass, 0o755);
    try {
      const env = buildServerEnv({
        parentEnv: { PATH: process.env.PATH },
        baseDir,
        scenario: 'echo',
        egressPort: recorder.port,
      });
      const ssh = 'git@github.com:octo/sandbox-test.git';
      const https = 'https://github.com/octo/sandbox-test.git';
      const viaBypass = ['-c', `core.sshCommand=${bypass}`, 'ls-remote'];

      // Layer 1: git refuses every transport but local files, before any attempt.
      const sshRefused = await git([...viaBypass, ssh], env, baseDir);
      const httpsRefused = await git(['ls-remote', https], env, baseDir);
      expect(sshRefused.code).not.toBe(0);
      expect(sshRefused.stderr).toContain("transport 'ssh' not allowed");
      expect(httpsRefused.code).not.toBe(0);
      expect(httpsRefused.stderr).toContain("transport 'https' not allowed");
      expect(readFileSync(paths.sshLog, 'utf8')).toBe('');
      expect(readFileSync(paths.egressLog, 'utf8')).toBe('');

      // Layer 2: without that, ssh is still the shim, even against core.sshCommand.
      const { GIT_ALLOW_PROTOCOL: _allowed, ...withoutAllowList } = env;
      const sshShimmed = await git([...viaBypass, ssh], withoutAllowList, baseDir);
      expect(sshShimmed.code).not.toBe(0);
      expect(sshShimmed.stderr).toContain('sandbox: ssh is disabled');
      expect(readFileSync(paths.sshLog, 'utf8')).toContain('git@github.com');
      expect(readFileSync(bypassLog, 'utf8')).toBe('');

      // Layer 3: and HTTPS goes to the egress recorder, which refuses and records it.
      const httpsRecorded = await git(['ls-remote', https], withoutAllowList, baseDir);
      expect(httpsRecorded.code).not.toBe(0);
      expect(readFileSync(paths.egressLog, 'utf8')).toMatch(/ CONNECT github\.com:443\n/);
    } finally {
      await recorder.close();
    }
  }, 120_000);
});
