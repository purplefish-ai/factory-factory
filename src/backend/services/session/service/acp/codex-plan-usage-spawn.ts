import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolveProviderAcpSpawnCommand, type SpawnCommand } from './acp-runtime-spawn';

const requireFromCurrentModule = createRequire(import.meta.url);

export function resolveCodexPlanUsageSpawnCommand(): SpawnCommand {
  if (process.platform !== 'win32') {
    const command = resolveProviderAcpSpawnCommand('CODEX');
    return { ...command, args: [...command.args, 'cli', 'app-server'] };
  }
  // Windows cannot kill a launcher's descendants after that launcher exits. Own
  // the native app-server directly; this quota-only probe starts no model turns.
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
    const executable = join(vendorRoot, target, 'bin', 'codex.exe').replace(
      /\.asar([/\\])/g,
      '.asar.unpacked$1'
    );
    if (!existsSync(executable)) {
      throw new Error('Missing executable');
    }
    return { command: executable, args: ['app-server'], commandLabel: 'codex app-server' };
  } catch {
    // Never fall back to an unowned launcher or an unrelated CLI from PATH.
    throw new Error('Codex plan usage native runtime unavailable');
  }
}
