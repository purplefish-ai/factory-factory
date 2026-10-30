import type { Command } from 'commander';
import { getOwnedClaudeCommand } from '@/backend/lib/claude-cli-command';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import { registerProviderCommand, runProviderCommand } from './provider-command';

export function registerClaudeCommand(
  program: Command,
  run: (args: string[]) => Promise<number> = runClaudeCommand
): void {
  registerProviderCommand(program, {
    name: 'claude',
    label: 'Claude',
    example: 'ff claude auth login',
    run,
  });
}

export function runClaudeCommand(args: string[]): Promise<number> {
  return runProviderCommand(getOwnedClaudeCommand(args, getCurrentProcessEnv()));
}
