import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { runProviderCommand } from './provider-command';

function isSourceCheckout(projectRoot: string): boolean {
  // Published packages contain dist, but omit the sources and build configs.
  return ['src/cli/index.ts', 'tsconfig.backend.json', 'vite.config.ts'].every((file) =>
    existsSync(join(projectRoot, file))
  );
}

export function getBuildRecoveryGuidance(projectRoot: string): string {
  return isSourceCheckout(projectRoot)
    ? 'Run `pnpm build` from the source checkout first (or use `ff build` from that checkout).'
    : 'The installed package is missing production assets. Reinstall factory-factory; building requires a source checkout.';
}

export function registerBuildCommand(program: Command, projectRoot: string): void {
  program
    .command('build')
    .description('Build a source checkout for production using its pnpm build pipeline')
    .action(async () => {
      if (!isSourceCheckout(projectRoot)) {
        console.error(
          '`ff build` requires a source checkout. Installed packages are already built.'
        );
        process.exitCode = 1;
        return;
      }
      try {
        process.exitCode = await runProviderCommand({
          command: 'pnpm',
          args: ['run', 'build'],
          cwd: projectRoot,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Could not run pnpm build: ${message}. Install the checkout's pinned pnpm version and run pnpm install first.`
        );
        process.exitCode = 1;
      }
    });
}
