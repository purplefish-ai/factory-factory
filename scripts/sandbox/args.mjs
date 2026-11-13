// Command-line interface of `pnpm dev:sandbox`.

export const USAGE = `Usage: pnpm dev:sandbox [--scenario <name>] [--keep] [--owner-pid <pid>]
                        [--ttl-minutes <n>]
       pnpm dev:sandbox --clean

Starts the real app (serve --dev) in a new directory under <os tmpdir>/ff-sandbox/
with its own HOME, database, worktrees, Codex home and Claude configuration.
Codex is the fake app-server. gh and ssh are stand-ins that record their calls
and fail; git may use local paths only; every other outbound HTTP(S) request,
including Claude's, goes to a local recorder that refuses it and logs its method,
host and port to egress-calls.log. Update checks and Slack intake are off, no
credential reaches the server, and projects must live inside the sandbox. Seeds
one project on a fresh Git repository with Codex as the default provider, then
prints one line: SANDBOX_READY <path to sandbox.json>.

On Ctrl+C, SIGTERM, server exit, owner exit or time-out it stops every process
it started and deletes the sandbox directory.

  --scenario <name>    Passed to the fake Codex app-server as FF_SANDBOX_SCENARIO
                       (default: echo). The fake rejects unknown names.
  --keep               Keep the sandbox directory after stopping.
  --owner-pid <pid>    Stop when this process exits (for example, the agent or
                       test run that started the sandbox).
  --ttl-minutes <n>    Stop after n minutes (default: 120; 0 never stops).
  --clean              Stop and delete sandboxes whose launcher is no longer running.

macOS and Linux only.
`;

/** The fake app-server scenario used when `--scenario` is not given. */
export const DEFAULT_SCENARIO = 'echo';
export const DEFAULT_TTL_MINUTES = 120;

function wholeNumber(flag, text, minimum) {
  if (!(text && /^\d+$/.test(text) && Number(text) >= minimum)) {
    throw new Error(`${flag} needs a whole number of at least ${minimum}.`);
  }
  return Number(text);
}

export function parseArgs(argv) {
  let scenario = null;
  let ownerPid = null;
  let ttlMinutes = null;
  const options = { mode: 'run', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.mode = 'help';
      break;
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
    } else if (arg === '--owner-pid') {
      ownerPid = wholeNumber(arg, argv[index + 1], 2);
      index += 1;
    } else if (arg === '--ttl-minutes') {
      ttlMinutes = wholeNumber(arg, argv[index + 1], 0);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (
    options.mode === 'clean' &&
    (options.keep || scenario || ownerPid !== null || ttlMinutes !== null)
  ) {
    throw new Error('--clean takes no other options.');
  }
  // Unset, the fake keeps a fixed reply; the sandbox's default echoes the prompt.
  return {
    ...options,
    scenario: scenario ?? DEFAULT_SCENARIO,
    ownerPid,
    ttlMinutes: ttlMinutes ?? DEFAULT_TTL_MINUTES,
  };
}
