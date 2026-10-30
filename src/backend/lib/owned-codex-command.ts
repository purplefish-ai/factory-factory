import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getBundledCodexCommand } from './codex-cli-command';

const requireFromCurrentModule = createRequire(import.meta.url);

export function getOwnedCodexCommand(
  args: string[],
  env?: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return getBundledCodexCommand(args);
  }
  if (env?.CODEX_PATH) {
    return { command: env.CODEX_PATH, args };
  }
  // Windows cannot kill a launcher's descendants after that launcher exits. Own
  // the native app-server directly; these native probes start no model turns.
  // Resolve through the adapter so pnpm/versioned dependencies stay aligned.
  try {
    const target =
      process.arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : process.arch === 'arm64'
          ? 'aarch64-pc-windows-msvc'
          : undefined;
    if (!target) {
      throw new Error('Unsupported architecture');
    }
    const adapter = requireFromCurrentModule.resolve('@agentclientprotocol/codex-acp/package.json');
    const codex = createRequire(adapter).resolve('@openai/codex/bin/codex.js');
    let vendorRoot: string;
    try {
      const platformPackage = createRequire(codex).resolve(
        `@openai/codex-win32-${process.arch}/package.json`
      );
      vendorRoot = join(dirname(platformPackage), 'vendor');
    } catch {
      // Older Codex installations bundled vendor/ inside the main package.
      vendorRoot = join(dirname(codex), '..', 'vendor');
    }
    // The pinned 0.164 launcher uses bin/. Accept the alternate codex/ layout
    // only when that owned executable is present, preserving older distributions.
    const executable = ['bin', 'codex']
      .map((directory) =>
        join(vendorRoot, target, directory, 'codex.exe').replace(
          /\.asar([/\\])/g,
          '.asar.unpacked$1'
        )
      )
      .find((candidate) => existsSync(candidate));
    if (!executable) {
      throw new Error('Missing executable');
    }
    return { command: executable, args };
  } catch {
    // Never fall back to an unowned launcher or an unrelated CLI from PATH.
    throw new Error('Codex native runtime unavailable');
  }
}
