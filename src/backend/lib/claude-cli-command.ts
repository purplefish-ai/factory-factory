import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** CLI operations and ACP sessions must use the same managed Claude runtime. */
export function getBundledClaudeCommand(args: string[]): { command: string; args: string[] } {
  const entrypoint = require
    .resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
    .replace(/\.asar([/\\])/g, '.asar.unpacked$1');
  return { command: process.execPath, args: [entrypoint, '--cli', ...args] };
}
