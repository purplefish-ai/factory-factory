import { createRequire } from 'node:module';
import { getNodeExecPath } from './node-runtime';

const require = createRequire(import.meta.url);

/** The managed CLI and ACP adapter must run the same bundled Codex version. */
export function getBundledCodexCommand(args: string[]): { command: string; args: string[] } {
  const entrypoint = require
    .resolve('@agentclientprotocol/codex-acp/dist/index.js')
    .replace(/\.asar([/\\])/g, '.asar.unpacked$1');
  // Upstream consumes --version before dispatching `cli`; -V reaches Codex.
  const nativeArgs = args.length === 1 && args[0] === '--version' ? ['-V'] : args;
  return { command: getNodeExecPath(), args: [entrypoint, 'cli', ...nativeArgs] };
}
