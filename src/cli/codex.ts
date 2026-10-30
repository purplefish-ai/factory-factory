import type { Command } from 'commander';
import { getOwnedCodexCommand } from '@/backend/lib/owned-codex-command';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import { registerProviderCommand, runProviderCommand } from './provider-command';

export function registerCodexCommand(
  program: Command,
  run: (args: string[]) => Promise<number> = runCodexCommand
): void {
  registerProviderCommand(program, {
    name: 'codex',
    label: 'Codex',
    example: 'ff codex login',
    run,
  });
}

export function runCodexCommand(args: string[]): Promise<number> {
  return runProviderCommand(getOwnedCodexCommand(args, getCurrentProcessEnv()));
}
