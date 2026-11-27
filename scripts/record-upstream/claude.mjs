// Records one synthetic Claude session through claude-agent-acp.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startAcpSession } from './acp-session.mjs';
import { cleanEnvironment, writeJsonLines } from './environment.mjs';

export const CLAUDE_SCENARIOS = [
  {
    scenario: 'plain-reply',
    text: 'Without using any tools, reply with two short sentences about why a README file is useful.',
  },
  {
    scenario: 'approved-command',
    text: 'Use the Bash tool to run exactly `sh count-words.sh` in this repository, then tell me its output in one sentence.',
    action: 'The permission request is answered with the allow_once option.',
  },
  {
    scenario: 'interrupted-reply',
    text: 'Without using any tools, count from one to one hundred in words, one number per line.',
    action:
      'session/cancel is sent when the third agent_message_chunk arrives; chunks already in flight can still follow it.',
  },
];

// The SDK starts this instead of the CLI (CLAUDE_CODE_EXECUTABLE). It runs the
// real executable and appends every stdin and stdout line to the log (0600).
function stdioWrapperSource(realExecutable, logPath) {
  return `#!${process.execPath}
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const log = fs.openSync(${JSON.stringify(logPath)}, 'a', 0o600);
const write = (record) => fs.writeSync(log, JSON.stringify(record) + '\\n');
const tee = (dir) => {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf('\\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) write({ dir, line });
      index = buffer.indexOf('\\n');
    }
  };
};
write({ dir: 'argv', args: process.argv.slice(2) });
const child = spawn(${JSON.stringify(realExecutable)}, process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const toCli = tee('sdk->cli');
const fromCli = tee('cli->sdk');
process.stdin.on('data', (chunk) => { toCli(chunk); child.stdin.write(chunk); });
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
child.stdout.on('data', (chunk) => { fromCli(chunk); process.stdout.write(chunk); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;
}

// Same lookup as the adapter's claudeCliPath(): on Linux the libc variant the
// runtime uses comes first.
function claudeCliPath(fromAdapter) {
  const fromSdk = createRequire(fromAdapter.resolve('@anthropic-ai/claude-agent-sdk'));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const musl =
    process.platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime;
  const candidates =
    process.platform === 'linux'
      ? musl
        ? [`${base}-musl/claude`, `${base}/claude`]
        : [`${base}/claude`, `${base}-musl/claude`]
      : [`${base}/claude`];
  for (const candidate of candidates) {
    try {
      return fromSdk.resolve(candidate);
    } catch {
      /* Try the other libc variant. */
    }
  }
  throw new Error(`No Claude CLI binary for ${process.platform}-${process.arch}`);
}

function listOrEmpty(directory) {
  return existsSync(directory) ? readdirSync(directory) : [];
}

function printLeftovers({ claudeHome, projectDir, sessionId, snapshotsDir, snapshotsBefore }) {
  const leftovers = [];
  if (existsSync(projectDir)) {
    leftovers.push(`${projectDir}/ (${readdirSync(projectDir).join(', ')})`);
  }
  const sessionEnv = sessionId && join(claudeHome, 'session-env', sessionId);
  if (sessionEnv && existsSync(sessionEnv)) {
    leftovers.push(`${sessionEnv}/`);
  }
  for (const name of listOrEmpty(snapshotsDir).filter((entry) => !snapshotsBefore.has(entry))) {
    leftovers.push(
      `${join(snapshotsDir, name)} (a shell snapshot; check it holds no own functions)`
    );
  }
  for (const path of leftovers) {
    console.log(`claude: left outside the temp directory: ${path}`);
  }
  console.log(
    `claude: ${join(homedir(), '.claude.json')} and its backups under ${join(claudeHome, 'backups')} were rewritten, as on any Claude run`
  );
  console.log(
    `claude: ${join(claudeHome, 'plugins', 'store')} may have had a built-in plugin record rewritten`
  );
}

/**
 * Runs the scenarios and writes raw captures into `rawDir`. The Claude sign-in
 * cannot be isolated (see the script header), so the CLI runs with the real
 * HOME and writes under ~/.claude; what it left there is printed, also when
 * the run fails.
 */
export async function recordClaude({ versions, repository, tmp, rawDir }) {
  const claudeHome = join(homedir(), '.claude');
  const snapshotsDir = join(claudeHome, 'shell-snapshots');
  const snapshotsBefore = new Set(listOrEmpty(snapshotsDir));
  const wrapper = join(tmp, 'claude-stdio-wrapper');
  const stdioLog = join(rawDir, 'cli-stdio.raw.jsonl');
  writeFileSync(wrapper, stdioWrapperSource(claudeCliPath(versions.fromAdapter), stdioLog));
  chmodSync(wrapper, 0o700);
  // An empty ZDOTDIR and an explicit SHELL (zsh, or sh where there is none)
  // keep the owner's shell setup (aliases, functions, options) out of the
  // Bash tool's shell snapshot.
  // Unverified until the next recording; the run lists any snapshot it made.
  const zdotdir = join(tmp, 'zdotdir');
  mkdirSync(zdotdir);
  const env = cleanEnvironment({
    home: homedir(),
    tmp,
    // The keychain sign-in is looked up for the real account name.
    user: process.env.USER ?? 'user',
    extra: {
      CLAUDE_CODE_EXECUTABLE: wrapper,
      SHELL: existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh',
      ZDOTDIR: zdotdir,
      // Keep the account's claude.ai connectors out of the synthetic session.
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
  });
  const projectDir = join(claudeHome, 'projects', repository.replace(/[^A-Za-z0-9]/g, '-'));
  let sessionId;
  try {
    const session = startAcpSession({
      entrypoint: versions.adapterEntrypoint,
      env,
      cwd: repository,
    });
    try {
      await session.initialize();
      const created = await session.newSession({
        cwd: repository,
        mcpServers: [],
        // Not sent by Factory Factory: keeps the owner's user settings (hooks,
        // plugins, CLAUDE.md) and MCP configuration out of the synthetic session.
        _meta: { claudeCode: { options: { settingSources: [], strictMcpConfig: true } } },
      });
      sessionId = created.sessionId;
      for (const { scenario, text } of CLAUDE_SCENARIOS) {
        let chunks = 0;
        const result = await session.prompt(
          { sessionId, prompt: [{ type: 'text', text }] },
          (notification) => {
            if (
              scenario === 'interrupted-reply' &&
              notification.update.sessionUpdate === 'agent_message_chunk' &&
              ++chunks === 3
            ) {
              void session.cancel({ sessionId });
            }
          }
        );
        console.log(`claude ${scenario}: stopReason=${result.stopReason}`);
      }
    } finally {
      await session.stop();
      writeJsonLines(join(rawDir, 'acp.raw.jsonl'), session.records, 0o600);
    }
    if (session.permissions.length === 0) {
      throw new Error('claude: the approved-command scenario raised no permission request');
    }
    const historyFile = join(projectDir, `${sessionId}.jsonl`);
    if (!existsSync(historyFile)) {
      throw new Error('The Claude history file for the recorded session was not found');
    }
    copyFileSync(historyFile, join(rawDir, 'history.raw.jsonl'));
    chmodSync(join(rawDir, 'history.raw.jsonl'), 0o600);
  } finally {
    // Also after a failure: whatever the CLI wrote under ~/.claude is the owner's to remove.
    printLeftovers({ claudeHome, projectDir, sessionId, snapshotsDir, snapshotsBefore });
  }
}
