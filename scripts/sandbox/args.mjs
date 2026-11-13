// Command-line interface of `pnpm dev:sandbox`.

export const USAGE = `Usage: pnpm dev:sandbox [--scenario <name>] [--keep] [--owner-pid <pid>]
                        [--ttl-minutes <n>]
       pnpm dev:sandbox --clean

Starts the real app (serve --dev) in a new directory under <os tmpdir>/ff-sandbox/
with its own HOME, database, worktrees, Codex home and Claude configuration.
Codex is the fake app-server. No credential reaches the server, update checks
and Slack intake are off, and projects must live inside the sandbox. Seeds one
project on a fresh Git repository with Codex as the default provider, then
prints one line: SANDBOX_READY <path to sandbox.json>.

Outbound traffic: the application's built-in fetch and http/https requests, git
over HTTP(S) and the Claude runtime are refused and recorded (method, host and
port in egress-calls.log); git over SSH and gh are refused by shims (their calls
in ssh-calls.log and gh-calls.log); WebSocket clients and clients that bring
their own agent are not proxied, and the sandbox relies on them having no
credential (voice) or being switched off (Slack). In practice git refuses every
transport but local paths itself, before it tries one, so neither log shows a
git attempt; the recorder and the ssh shim are its second line.

What the sandbox does not contain:
  - Clients that ignore proxy variables: WebSocket (voice narration reaches
    Deepgram once a key is saved in the sandbox), custom agents, raw TCP,
    docker, and scp, sftp or ssh run by absolute path.
  - OpenSSH reads ~/.ssh from the real home directory, and the macOS keychain
    is readable by any process: not a boundary against a hostile agent.
  - A SIGKILLed launcher's server keeps running until --clean.
  - A managed Codex account drops CODEX_PATH, so the real Codex binary runs,
    without a credential.

On Ctrl+C, SIGTERM, server exit, owner exit or time-out it stops every process
it started and deletes the sandbox directory. If ps cannot run when it stops
(for example after three failed readings in a row), it signals only the server
process group it started itself, keeps the directory, says so and exits
non-zero; run --clean once ps works.

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
