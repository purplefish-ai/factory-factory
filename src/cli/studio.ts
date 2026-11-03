import { createRequire } from 'node:module';
import chalk from 'chalk';
import type { Command } from 'commander';
import { resolveDatabasePath } from './database-path';
import { runProviderCommand } from './provider-command';
import { getStudioDatabaseUrl } from './studio-database-url';

const require = createRequire(import.meta.url);

export function registerStudioCommand(program: Command, projectRoot: string): void {
  program
    .command('db:studio')
    .description('Open Prisma Studio for database management')
    .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
    .option('-p, --port <port>', 'Port for Prisma Studio (otherwise selects an available port)')
    .action(async (options: { databasePath?: string; port?: string }) => {
      const effectivePath = resolveDatabasePath({ databasePath: options.databasePath });
      console.log(chalk.blue(`Opening Prisma Studio for ${effectivePath}...`));
      try {
        const args = [
          require.resolve('prisma/build/index.js'),
          'studio',
          '--url',
          getStudioDatabaseUrl(effectivePath),
        ];
        if (options.port !== undefined) {
          args.push('--port', options.port);
        }
        process.exitCode = await runProviderCommand({
          command: process.execPath,
          args,
          cwd: projectRoot,
        });
      } catch (error) {
        console.error(chalk.red('Prisma Studio failed:'), error);
        process.exitCode = 1;
      }
    });
}
