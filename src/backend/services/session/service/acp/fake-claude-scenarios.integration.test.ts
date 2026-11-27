import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { RequestPermissionRequest, SessionUpdate } from '@/shared/acp-protocol/sdk-types';
import { AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpProcessHandle } from './acp-process-handle';

// Plays the fake Claude CLI's scenarios through the released Claude ACP adapter and the Claude
// Agent SDK it runs, as the application starts them, and checks what an ACP client receives.

const dirs: string[] = [];
const handles: AcpProcessHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.child.stdin?.end();
    await cleanupFailedAcpClientCreation(handle.child, 'claude-scenario');
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A new directory holding the fake as `claude`; HOME and CLAUDE_CONFIG_DIR live in it. */
async function fakeHome() {
  // The session working directory arrives resolved; macOS temp dirs live under /private.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ff-claude-scenario-')));
  dirs.push(dir);
  const fake = join(dir, 'claude');
  await copyFile(
    new URL('../../../../testing/fixtures/fake-claude-cli.mjs', import.meta.url),
    fake
  );
  await chmod(fake, 0o755);
  const home = join(dir, 'home');
  const workingDir = join(dir, 'repo');
  await mkdir(home);
  await mkdir(workingDir);
  return { dir, fake, home, workingDir, log: join(dir, 'claude-calls.log') };
}

/** One line of the fake's call log. */
const callSchema = z.object({
  argv: z.array(z.string()).optional(),
  control: z.string().optional(),
});

const never = {
  promise: new Promise<never>(() => {
    /* No cancellation during the scenario. */
  }),
  dispose() {
    /* Test signal has no listeners. */
  },
};

/** Starts the adapter on the fake, sends `prompt` and answers a permission with `optionId`. */
async function playScenario(prompt: string, optionId = 'allow-once') {
  const home = await fakeHome();
  const updates: SessionUpdate[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const bridge = new AcpPermissionBridge();
  const factory = new AcpClientFactory();
  factory.configureEnvironment({
    childProcessEnvProvider: () => ({
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TEMP: tmpdir(),
      TMP: tmpdir(),
      HOME: home.home,
      CLAUDE_CONFIG_DIR: join(home.dir, 'claude-config'),
      CLAUDE_CODE_EXECUTABLE: home.fake,
      FF_SANDBOX_CLAUDE_LOG: home.log,
      FF_SANDBOX_SCENARIO: 'echo',
    }),
  });
  const handle = await factory.createClient({
    sessionId: 'claude-scenario',
    options: { provider: 'CLAUDE', workingDir: home.workingDir, sessionId: 'claude-scenario' },
    handlers: {
      permissionBridge: bridge,
      onAcpEvent: (_id, event) => {
        if (event.type === 'acp_session_update') {
          updates.push(event.update);
        } else if (event.type === 'acp_permission_request') {
          permissions.push(event.params);
          bridge.resolvePermission(event.requestId, optionId);
        }
      },
    },
    metadata: { incarnationId: 'claude-scenario', purpose: 'active', installed: false },
    shutdownSignal: never,
    stopSignal: never,
    shouldDispatchRuntimeError: () => false,
  });
  handles.push(handle);
  const response = await handle.connection.prompt({
    sessionId: handle.providerSessionId,
    prompt: [{ type: 'text', text: prompt }],
  });
  const chunks = updates.flatMap((update) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text]
      : []
  );
  const calls = readFileSync(home.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => callSchema.parse(JSON.parse(line)));
  return { response, updates, permissions, reply: chunks.join(''), calls };
}

it('echoes a prompt through the released adapter', async () => {
  const played = await playScenario('Hello from the Claude sandbox');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.reply).toBe('Hello from the Claude sandbox');
  // The SDK started the fake in stream-json mode, and the adapter probed its sign-in.
  const argvs = played.calls.flatMap((call) => (call.argv ? [call.argv.join(' ')] : []));
  expect(argvs).toContainEqual(expect.stringContaining('--input-format stream-json'));
  expect(argvs).toContain('auth status --json');
}, 30_000);

it('asks before running a command, runs it when allowed and says so', async () => {
  const played = await playScenario('Please ff-scenario:permission-request');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.permissions).toHaveLength(1);
  expect(played.permissions[0]?.toolCall.rawInput).toMatchObject({
    command: 'echo "Hello from the sandbox"',
  });
  expect(played.reply).toBe('You approved the command, so I ran it.');
  expect(played.updates).toContainEqual(
    expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed' })
  );
}, 30_000);

it('goes on without the command when the user declines it', async () => {
  const played = await playScenario('Please ff-scenario:permission-request', 'reject');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.permissions).toHaveLength(1);
  expect(played.reply).toBe('You declined the command, so I did not run it.');
}, 30_000);
