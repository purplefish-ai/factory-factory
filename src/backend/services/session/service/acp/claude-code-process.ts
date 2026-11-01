import { spawn } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { getNodeExecPath } from '@/backend/lib/node-runtime';

/** Launch SDK-managed Claude processes using the bundled Node runtime in Electron. */
export function spawnClaudeCodeProcess(options: SpawnOptions) {
  return spawn(
    options.command === 'node' ? getNodeExecPath() : options.command,
    options.args.map((argument) => argument.replace(/\.asar([/\\])/g, '.asar.unpacked$1')),
    {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
}
