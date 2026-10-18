import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { getBundledCodexCommand } from '@/backend/lib/codex-cli-command';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';

export function registerCodexCommand(
  program: Command,
  run: (args: string[]) => Promise<number> = runCodexCommand
): void {
  program.enablePositionalOptions();
  program
    .command('codex')
    .description('Run the bundled Codex CLI (for example: ff codex login)')
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args: string[]) => {
      process.exitCode = await run(args);
    });
}

export async function runCodexCommand(args: string[]): Promise<number> {
  const command = getBundledCodexCommand(args);
  const child = spawn(command.command, command.args, {
    stdio: 'inherit',
    env: { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' },
  });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
