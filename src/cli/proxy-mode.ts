import { type Command, Option } from 'commander';

export interface ProxyCommandOptions {
  /** Share without a password; the tunnel is then read-only. */
  public?: boolean;
  /** Require a password. The default; accepted so existing scripts keep working. */
  private?: boolean;
}

export type ProxyMode = 'private' | 'public';

/** Password protection is the default; unauthenticated sharing must be explicit. */
export function resolveProxyMode(options: ProxyCommandOptions): ProxyMode {
  if (options.public && options.private) {
    throw new Error('--public and --private cannot be used together.');
  }
  return options.public ? 'public' : 'private';
}

export const PUBLIC_MODE_WARNING = [
  '⚠️  Public tunnel: no password.',
  'Anyone with this URL can view this Factory Factory instance, including',
  'workspace file contents. The tunnel is read-only: changes, agent sessions,',
  'chat and terminals are blocked. Run `ff proxy` without --public to require',
  'a password instead.',
].join('\n   ');

export function registerProxyCommand(
  program: Command,
  run: (options: ProxyCommandOptions) => Promise<void>
): void {
  program
    .command('proxy')
    .description(
      'Share your local Factory Factory server through a Cloudflare tunnel (password-protected by default)'
    )
    .addOption(
      new Option(
        '--public',
        'Share without a password: anyone with the URL can view the app, including file contents (read-only)'
      ).conflicts('private')
    )
    .addOption(
      new Option('--private', 'Require a password (the default; kept for compatibility)').conflicts(
        'public'
      )
    )
    .action(async (options: ProxyCommandOptions) => {
      await run(options);
    });
}
