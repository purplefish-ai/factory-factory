import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** CLI operations and ACP sessions must use the same managed Claude runtime. */
export function getBundledClaudeCommand(args: string[]): { command: string; args: string[] } {
  const entrypoint = require
    .resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
    .replace(/\.asar([/\\])/g, '.asar.unpacked$1');
  return { command: process.execPath, args: [entrypoint, '--cli', ...args] };
}

/** Windows must own the native CLI so launcher exit cannot orphan it. */
export function getOwnedClaudeCommand(
  args: string[],
  env: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return getBundledClaudeCommand(args);
  }
  if (env.CLAUDE_CODE_EXECUTABLE) {
    return { command: env.CLAUDE_CODE_EXECUTABLE, args };
  }
  const adapter = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const sdk = createRequire(adapter).resolve('@anthropic-ai/claude-agent-sdk');
  const command = createRequire(sdk)
    .resolve(`@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`)
    .replace(/\.asar([/\\])/g, '.asar.unpacked$1');
  return { command, args };
}
