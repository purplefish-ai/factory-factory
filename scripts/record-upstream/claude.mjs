// Records one synthetic Claude session through claude-agent-acp.
import { chmodSync, copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
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
    action: 'session/cancel is sent after the third agent_message_chunk.',
  },
];

// The SDK starts this instead of the CLI (CLAUDE_CODE_EXECUTABLE). It runs the
// real executable and appends every stdin and stdout line to the log.
function stdioWrapperSource(realExecutable, logPath) {
  return `#!${process.execPath}
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const log = fs.openSync(${JSON.stringify(logPath)}, 'a');
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

function claudeCliPath(fromAdapter) {
  // Same lookup as the adapter's claudeCliPath() on macOS and glibc Linux.
  const fromSdk = createRequire(fromAdapter.resolve('@anthropic-ai/claude-agent-sdk'));
  return fromSdk.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
  );
}

/**
 * Runs the scenarios and writes raw captures into `rawDir`. The Claude sign-in
 * cannot be isolated (see the script header), so the CLI runs with the real
 * HOME and writes its history under ~/.claude/projects/<encoded cwd>/.
 */
export async function recordClaude({ versions, repository, tmp, rawDir }) {
  const wrapper = join(tmp, 'claude-stdio-wrapper');
  const stdioLog = join(rawDir, 'cli-stdio.raw.jsonl');
  writeFileSync(wrapper, stdioWrapperSource(claudeCliPath(versions.fromAdapter), stdioLog));
  chmodSync(wrapper, 0o700);
  const env = cleanEnvironment({
    home: homedir(),
    tmp,
    extra: {
      CLAUDE_CODE_EXECUTABLE: wrapper,
      // Keep the account's claude.ai connectors out of the synthetic session.
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
  });
  const session = startAcpSession({ entrypoint: versions.adapterEntrypoint, env, cwd: repository });
  let sessionId;
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
    writeJsonLines(join(rawDir, 'acp.raw.jsonl'), session.records);
  }
  if (session.permissions.length === 0) {
    console.warn('claude: no permission request was observed');
  }
  const projectDir = join(
    homedir(),
    '.claude',
    'projects',
    repository.replace(/[^A-Za-z0-9]/g, '-')
  );
  const historyFile = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(historyFile)) {
    throw new Error('The Claude history file for the recorded session was not found');
  }
  copyFileSync(historyFile, join(rawDir, 'history.raw.jsonl'));
  console.log(`claude: the CLI wrote ${projectDir} (${readdirSync(projectDir).join(', ')})`);
  return { createdOutsideTemp: [projectDir] };
}
