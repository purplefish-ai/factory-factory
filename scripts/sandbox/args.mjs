// Command-line interface of `pnpm dev:sandbox`.

export const USAGE = `Usage: pnpm dev:sandbox [--scenario <name>] [--keep]
       pnpm dev:sandbox --clean

Starts the real app (serve --dev) in a new directory under <os tmpdir>/ff-sandbox/
with its own HOME, database, worktrees, Codex home and Claude configuration. Codex is
the fake app-server, gh records its calls and fails, update checks and Slack
intake are off, and no Anthropic or Claude credential reaches the server. Seeds
one project on a fresh Git repository with Codex as the default provider, then
prints one line: SANDBOX_READY <path to sandbox.json>.

On Ctrl+C, SIGTERM or server exit it stops every process it started and deletes
the sandbox directory.

  --scenario <name>  Passed to the fake Codex app-server as FF_SANDBOX_SCENARIO
                     (default: echo). The fake rejects unknown names.
  --keep             Keep the sandbox directory after stopping.
  --clean            Stop and delete sandboxes whose launcher is no longer running.

macOS and Linux only.
`;

/** The fake app-server scenario used when `--scenario` is not given. */
export const DEFAULT_SCENARIO = 'echo';

export function parseArgs(argv) {
  let scenario = null;
  const options = { mode: 'run', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, mode: 'help' };
    }
    if (arg === '--clean') {
      options.mode = 'clean';
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--scenario') {
      const name = argv[index + 1];
      if (!(name && /^[A-Za-z0-9._-]+$/.test(name))) {
        throw new Error('--scenario needs a name made of letters, digits, ".", "_" or "-".');
      }
      scenario = name;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.mode === 'clean' && (options.keep || scenario)) {
    throw new Error('--clean takes no other options.');
  }
  // Unset, the fake keeps a fixed reply; the sandbox's default echoes the prompt.
  return { ...options, scenario: scenario ?? DEFAULT_SCENARIO };
}
