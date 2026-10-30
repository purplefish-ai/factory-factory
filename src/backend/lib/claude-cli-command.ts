import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

interface ClaudeUpdateCommand {
  command: string;
  args: string[];
}

async function findClaudeExecutable(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathKey =
    process.platform === 'win32'
      ? Object.keys(env)
          .sort()
          .find((key) => key.toLowerCase() === 'path')
      : 'PATH';
  const directories = (pathKey ? (env[pathKey] ?? '') : '').split(delimiter);
  const names = process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude'];

  for (const directory of directories) {
    for (const name of names) {
      try {
        const candidate = join(directory, name);
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          return (await realpath(candidate)).replaceAll('\\', '/');
        }
      } catch {
        // Missing or inaccessible entries do not shadow a later executable.
      }
    }
  }

  return undefined;
}

/** Select the updater for the first Claude executable on the app's PATH. */
export async function resolveClaudeUpdateCommand(
  env: NodeJS.ProcessEnv
): Promise<ClaudeUpdateCommand> {
  const executable = await findClaudeExecutable(env);
  const cask = executable?.match(/^(.*)\/Caskroom\/(claude-code(?:@latest)?)\//);
  if (cask?.[1] && cask[2]) {
    return { command: `${cask[1]}/bin/brew`, args: ['upgrade', '--cask', cask[2]] };
  }
  if (executable && /\/WinGet\/Packages\/Anthropic\.ClaudeCode_[^/]+\//i.test(executable)) {
    return {
      command: 'winget',
      args: [
        'upgrade',
        '--id',
        'Anthropic.ClaudeCode',
        '--exact',
        '--silent',
        '--disable-interactivity',
      ],
    };
  }
  // A later PATH entry may be package-managed, but it is not the active CLI.
  return { command: 'claude', args: ['update'] };
}
