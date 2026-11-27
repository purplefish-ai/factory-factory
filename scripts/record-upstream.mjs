// Records what the real Claude and Codex tools exchange with Factory Factory,
// so parsers and fakes can be pinned to real shapes (task 2.9).
//
// Usage (from the repository root, with your own Claude and Codex sign-ins;
// macOS or Linux):
//
//   node scripts/record-upstream.mjs claude
//   node scripts/record-upstream.mjs codex
//
// Each run creates a throwaway git repository in a temp directory, starts the
// bundled ACP adapter in a clean environment (`PATH`, `HOME`, `USER`, `TMPDIR`,
// `TERM`, `LANG`, `TZ`, an empty git configuration and the variables listed in
// the provider module, nothing from your shell), and plays the synthetic
// prompts in scripts/record-upstream/<provider>.mjs. Nothing else is prompted.
//
// It writes src/backend/testing/fixtures/upstream/<tool>/<runtime version>/,
// replacing that version's directory only once every file is written. The
// runtime version is the @anthropic-ai/claude-agent-sdk or @openai/codex
// version the adapter resolves, found the way
// scripts/prepare-runtime-metadata.mjs finds it.
//
// - acp.jsonl: every ACP message, client->agent and agent->client, in order.
// - cli-stdio.jsonl (Claude): what the SDK and the CLI exchanged, captured by a
//   wrapper named in CLAUDE_CODE_EXECUTABLE.
// - history.jsonl: the history file the CLI wrote for the session.
// - app-server.jsonl (Codex): the app-server reads made outside a turn.
// - prompts.json and meta.json.
//
// Every value passes the allowlist scrubber in scripts/record-upstream/scrub.mjs
// (rules in policies.mjs, field names in known-keys.json) and the leak test in
// src/backend/testing/upstream-recordings-leak.test.ts. A new upstream field
// shows up as "<key>" until someone reads it and names it. Read every file
// before you push: pushing publishes it.
//
// Credentials and side effects:
// - Codex: auth.json is copied (mode 0600) into a temp CODEX_HOME, with a temp
//   HOME; the copy is deleted when the run ends, also on Ctrl-C, SIGTERM,
//   SIGHUP or a crash. The run refuses to start if the sign-in is due for a
//   refresh, so the copy never rotates your token. Nothing is written under
//   ~/.codex.
// - Claude: the sign-in lives in the macOS keychain under the default config
//   directory and does not follow CLAUDE_CONFIG_DIR or a temp HOME, so the CLI
//   runs with your real HOME. Its user settings are not loaded
//   (settingSources: []). It leaves, and the run prints:
//   ~/.claude/projects/<encoded temp path>/ (the session file), an empty
//   ~/.claude/session-env/<session id>/, and any new file in
//   ~/.claude/shell-snapshots/. It also rewrites ~/.claude.json, rotates its
//   backups under ~/.claude/backups/ and may rewrite a built-in plugin record
//   under ~/.claude/plugins/store/, as any Claude run does.
// - The Bash tool snapshots the user's shell setup. The Claude run sets an
//   empty ZDOTDIR and SHELL=/bin/zsh so the snapshot holds no aliases or
//   functions of yours. This isolation is unverified until the next
//   recording: read the snapshot the run lists before trusting it.
//
// Cost: Claude makes three short turns (one interrupted), Codex two, on the
// account's default model. Each turn carries the tool's own system prompt
// (about 20k mostly cached input tokens, under 200 output tokens), so a run is
// roughly 60k input tokens for Claude and 50k for Codex: a few cents to a few
// tens of cents, or the same share of a subscription's usage. Codex also makes
// four app-server reads that start no turn. Run each provider once; if a run
// fails twice, stop and look rather than retrying.
//
// `--keep-raw <dir>` keeps the unscrubbed captures (files 0600 in a 0700
// directory, which must be outside this repository; they hold account details,
// so delete them when done); `--rescrub <dir>` rewrites the fixtures from kept
// captures without running any session.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CLAUDE_SCENARIOS, recordClaude } from './record-upstream/claude.mjs';
import { CODEX_SCENARIOS, recordCodex } from './record-upstream/codex.mjs';
import {
  assertSupportedPlatform,
  createThrowawayRepository,
  installAbortCleanup,
  readJsonLines,
  removeOnAbort,
  REPOSITORY_FILES,
  resolveVersions,
  writeJsonLines,
} from './record-upstream/environment.mjs';
import {
  createScrubContext,
  POLICIES,
  scrubCapturedLines,
  scrubRecord,
} from './record-upstream/scrub.mjs';

const FIXTURES = join(process.cwd(), 'src', 'backend', 'testing', 'fixtures', 'upstream');
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const USAGE =
  'Usage: node scripts/record-upstream.mjs <claude|codex> [--keep-raw <dir> | --rescrub <dir>]';

const TOOLS = {
  claude: {
    scenarios: CLAUDE_SCENARIOS,
    record: recordClaude,
    streams: [
      ['acp', 'acp.jsonl', POLICIES.acp],
      ['cli-stdio', 'cli-stdio.jsonl', POLICIES.claudeStdio],
      ['history', 'history.jsonl', POLICIES.claudeHistory],
    ],
    notes: [
      "session/new carries _meta.claudeCode.options {settingSources: [], strictMcpConfig: true}, which Factory Factory does not send, to keep the recording account's user settings, hooks and MCP servers out of the session.",
      'ENABLE_CLAUDEAI_MCP_SERVERS=false keeps claude.ai connectors out of the session.',
      'The adapter also runs `claude auth status --json` through CLAUDE_CODE_EXECUTABLE. Each run is an argv record; its multi-line output is joined into one cli->sdk message, which can interleave with the session stream.',
    ],
  },
  codex: {
    scenarios: CODEX_SCENARIOS,
    record: recordCodex,
    streams: [
      ['app-server', 'app-server.jsonl', POLICIES.codexAppServer],
      ['acp', 'acp.jsonl', POLICIES.acp],
      ['history', 'history.jsonl', POLICIES.codexRollout],
    ],
    notes: [
      'CODEX_HOME starts with only a copy of auth.json and HOME is empty, so no user config.toml, AGENTS.md or skills are loaded; Codex installs its bundled system skills there itself.',
      'The session is switched to the read-only mode before the first prompt.',
    ],
  },
};

const FILE_DESCRIPTIONS = {
  'acp.jsonl': 'Every ACP JSON-RPC message between client and adapter, in order.',
  'cli-stdio.jsonl': 'stream-json lines between the Claude Agent SDK and the Claude Code CLI.',
  'history.jsonl': 'The history file the CLI wrote for the session, line by line.',
  'app-server.jsonl': 'Codex app-server requests and responses read outside a turn.',
  'prompts.json': 'The prompts sent, one per turn.',
};

function parseArguments(argv) {
  const [tool, ...rest] = argv;
  if (!(tool in TOOLS)) {
    throw new Error(USAGE);
  }
  const options = { tool };
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (!(flag === '--keep-raw' || flag === '--rescrub')) {
      throw new Error(`Unknown option ${flag}. ${USAGE}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} needs a directory. ${USAGE}`);
    }
    options[flag === '--keep-raw' ? 'keepRaw' : 'rescrub'] = value;
  }
  if (options.keepRaw && options.rescrub) {
    throw new Error(`--keep-raw and --rescrub cannot be combined. ${USAGE}`);
  }
  return options;
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === '' || !(path.startsWith('..') || isAbsolute(path));
}

// Raw captures hold account details: never inside the checkout, never readable by others.
function prepareRawDirectory(directory) {
  const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const checkout = realpathSync(toplevel.stdout?.trim() || process.cwd());
  const refuse = () => {
    throw new Error('--keep-raw must name a directory outside this repository');
  };
  if (isInside(resolve(directory), checkout)) {
    refuse();
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A symlink can still lead into the checkout.
  const real = realpathSync(directory);
  if (isInside(real, checkout)) {
    refuse();
  }
  chmodSync(real, 0o700);
  return real;
}

function scrubStream(name, rawPath, policy, context) {
  const records = readJsonLines(rawPath);
  return name === 'history'
    ? records.map((record) => scrubRecord(record, policy, context))
    : scrubCapturedLines(records, policy, context);
}

function parsedOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function cliVersion(tool, rawDir) {
  const lines =
    tool === 'claude'
      ? readJsonLines(join(rawDir, 'cli-stdio.raw.jsonl'))
          .filter((record) => record.dir === 'cli->sdk')
          .map((record) => parsedOrNull(record.line))
      : readJsonLines(join(rawDir, 'history.raw.jsonl'));
  for (const message of lines.filter(Boolean)) {
    const version = message.claude_code_version ?? message.payload?.cli_version;
    if (typeof version === 'string' && VERSION.test(version)) {
      return version;
    }
  }
  return null;
}

function writeVersionDirectory(tool, rawDir, run, target) {
  const config = TOOLS[tool];
  const context = createScrubContext({ roots: run.roots });
  const files = {};
  for (const [name, file, policy] of config.streams) {
    writeJsonLines(
      join(target, file),
      scrubStream(name, join(rawDir, `${name}.raw.jsonl`), policy, context)
    );
    files[file] = FILE_DESCRIPTIONS[file];
  }
  const prompts = config.scenarios.map(({ scenario, text, action }) => ({
    scenario,
    text,
    ...(action ? { action } : {}),
  }));
  writeFileSync(join(target, 'prompts.json'), `${JSON.stringify(prompts, null, 2)}\n`);
  files['prompts.json'] = FILE_DESCRIPTIONS['prompts.json'];
  const meta = {
    tool,
    runtime: { package: run.runtime, version: run.runtimeVersion },
    adapter: { package: run.adapter, version: run.adapterVersion },
    cliVersion: cliVersion(tool, rawDir),
    recordedOn: run.recordedOn,
    platform: run.platform,
    scenarios: config.scenarios.map(({ scenario }) => scenario),
    // The throwaway git repository the session ran in, at /workspace.
    repository: REPOSITORY_FILES,
    files,
    notes: config.notes,
    scrubbing:
      'Allowlist by record kind and key path (scripts/record-upstream/policies.mjs); unknown kinds are opaque, unlisted strings "<string>", unlisted numbers 0, unknown keys "<key>"; ids and timestamps are fixed fakes; the repository is /workspace.',
  };
  writeFileSync(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const format = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'oxfmt'),
    ['--write', target],
    {
      stdio: 'ignore',
    }
  );
  if (format.error || format.status !== 0) {
    throw new Error('oxfmt could not format the new recordings');
  }
  return context.redactions;
}

/**
 * Writes the scrubbed fixtures for `tool` from the raw captures in `rawDir`,
 * into a sibling directory first, and replaces the version's directory only
 * when every file is written.
 */
function writeFixtures(tool, rawDir) {
  const run = JSON.parse(readFileSync(join(rawDir, 'run.json'), 'utf8'));
  if (typeof run.runtimeVersion !== 'string' || !VERSION.test(run.runtimeVersion)) {
    throw new Error('run.json does not name a runtime version');
  }
  const toolDirectory = join(FIXTURES, tool);
  const target = join(toolDirectory, run.runtimeVersion);
  if (dirname(target) !== toolDirectory) {
    throw new Error('The runtime version resolves outside the fixtures directory');
  }
  mkdirSync(toolDirectory, { recursive: true });
  const staging = mkdtempSync(join(toolDirectory, `.${run.runtimeVersion}-`));
  removeOnAbort.add(staging);
  try {
    const redactions = writeVersionDirectory(tool, rawDir, run, staging);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    console.log(`${tool}: wrote ${target} (${redactions} text values redacted)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    removeOnAbort.delete(staging);
  }
}

async function record(tool, keepRaw) {
  const versions = resolveVersions(tool);
  const rawKept = keepRaw ? prepareRawDirectory(keepRaw) : undefined;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ff-upstream-')));
  // Ctrl-C, SIGTERM, SIGHUP or a crash must not leave the sign-in copy or raw captures behind.
  removeOnAbort.add(tmp);
  const uninstallAbortCleanup = installAbortCleanup();
  const rawDir = rawKept ?? join(tmp, 'raw');
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const repository = join(tmp, 'repository');
  try {
    createThrowawayRepository(repository, join(tmp, 'git-home'));
    const run = {
      runtime: versions.runtime,
      runtimeVersion: versions.runtimeVersion,
      adapter: versions.adapter,
      adapterVersion: versions.adapterVersion,
      recordedOn: new Date().toISOString().slice(0, 10),
      platform: `${process.platform}-${process.arch}`,
      // Longest first is applied by the scrubber; the repository wins over tmp.
      roots: { [repository]: '/workspace', [tmp]: '/recording-tmp', [homedir()]: '/user-home' },
    };
    writeFileSync(join(rawDir, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    const { leftovers, notes } = await TOOLS[tool].record({ versions, repository, tmp, rawDir });
    writeFixtures(tool, rawDir);
    for (const path of leftovers) {
      console.log(`${tool}: left outside the temp directory: ${path}`);
    }
    for (const note of notes) {
      console.log(`${tool}: ${note}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    removeOnAbort.delete(tmp);
    uninstallAbortCleanup();
  }
}

assertSupportedPlatform();
const options = parseArguments(process.argv.slice(2));
if (options.rescrub) {
  if (!existsSync(join(options.rescrub, 'run.json'))) {
    throw new Error('--rescrub needs a directory written with --keep-raw');
  }
  writeFixtures(options.tool, options.rescrub);
} else {
  await record(options.tool, options.keepRaw);
}
