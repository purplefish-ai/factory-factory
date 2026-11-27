import { spawn } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { getNodeExecPath } from '@/backend/lib/node-runtime';

/**
 * The SDK's option for the CLI named by CLAUDE_CODE_EXECUTABLE (`executable`), so that a direct
 * `query()` runs the same CLI as the ACP adapter, which reads that variable itself. Empty without
 * it: the SDK then runs its bundled CLI.
 */
export function claudeCodeExecutableOption(executable: string | undefined): {
  pathToClaudeCodeExecutable?: string;
} {
  return executable ? { pathToClaudeCodeExecutable: executable } : {};
}

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
