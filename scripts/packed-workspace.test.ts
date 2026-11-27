import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { driveWorkspace, FIRST_PROMPT, parseWorktreeList } from './packed-workspace.mjs';

const ORIGIN = 'http://127.0.0.1:4100';
const REPO = '/consumer/projects/repo-abc';
const WORKTREE = '/consumer/data/worktrees/repo-abc/workspace-w1';

/** Chat frames the packed server sent in a passing macOS run, trimmed to the ones that matter. */
const LIVE_REPLY = [
  { type: 'session_replay_batch', replayEvents: [] },
  { type: 'message_state_changed', id: 'm1', newState: 'DISPATCHED' },
  {
    type: 'session_delta',
    data: {
      type: 'transcript_message_committed',
      chatMessage: { id: 'm1', source: 'user', text: FIRST_PROMPT, order: 0 },
      queuedMessages: [],
    },
  },
  {
    type: 'session_delta',
    data: { type: 'assistant_text_delta', messageId: 'a1', order: 1, offset: 0, text: 'Packed ' },
  },
  {
    type: 'session_delta',
    data: {
      type: 'assistant_text_delta',
      messageId: 'a1',
      order: 1,
      offset: 7,
      text: FIRST_PROMPT.slice(7),
    },
  },
];

/** The same conversation replayed to a client that connects after the turn finished. */
const REPLAYED_REPLY = [
  {
    type: 'session_replay_batch',
    replayEvents: [
      {
        type: 'agent_message',
        data: { type: 'user', message: { role: 'user', content: FIRST_PROMPT } },
      },
      {
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: FIRST_PROMPT }] },
        },
        order: 1,
      },
    ],
  },
];

/** Only the user's own message: the prompt text, but never an agent reply. */
const NO_REPLY = [
  {
    type: 'session_delta',
    data: {
      type: 'transcript_message_committed',
      chatMessage: { id: 'm1', source: 'user', text: FIRST_PROMPT, order: 0 },
      queuedMessages: [],
    },
  },
  {
    type: 'session_delta',
    data: {
      type: 'agent_message',
      data: { type: 'user', message: { role: 'user', content: FIRST_PROMPT } },
    },
  },
];

const FAILED_TURN = [
  {
    type: 'session_delta',
    data: {
      type: 'message_state_changed',
      id: 'm1',
      newState: 'FAILED',
      errorMessage: 'adapter exited',
    },
  },
];

class FakeChatSocket extends EventEmitter {
  readonly sent: unknown[] = [];

  constructor(
    readonly url: string,
    private readonly frames: unknown[]
  ) {
    super();
    setImmediate(() => this.emit('open'));
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
    for (const frame of this.frames) {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(frame))));
    }
  }

  close(): void {
    setImmediate(() => this.emit('close'));
  }

  terminate(): void {
    this.close();
  }
}

const requestSchema = z.object({ json: z.record(z.string(), z.unknown()) });

/**
 * The packed server's tRPC surface for one project and one workspace. The workspace is
 * PROVISIONING for the first `provisioningPolls` reads, then `finalStatus`.
 */
function fakeServer({
  frames = LIVE_REPLY,
  finalStatus = 'READY',
  provisioningPolls = 2,
  worktrees = [REPO, WORKTREE],
}: {
  frames?: unknown[];
  finalStatus?: string;
  provisioningPolls?: number;
  worktrees?: string[];
} = {}) {
  const calls: { path: string; origin: string | null; input: Record<string, unknown> }[] = [];
  const sockets: FakeChatSocket[] = [];
  let polls = 0;
  const answer = (json: unknown) => new Response(JSON.stringify({ result: { data: { json } } }));
  const respond = (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/api/trpc/', '');
    const raw = init.method === 'POST' ? String(init.body) : parsed.searchParams.get('input');
    const input = requestSchema.parse(JSON.parse(raw ?? '{}')).json;
    const origin = new Headers(init.headers).get('origin');
    calls.push({ path, origin, input });
    switch (path) {
      case 'project.create':
        return answer({ id: 'p1' });
      case 'workspace.create':
        return answer({ id: 'w1', status: 'NEW' });
      case 'workspace.get': {
        polls += 1;
        const status = polls > provisioningPolls ? finalStatus : 'PROVISIONING';
        return answer({
          status,
          worktreePath: status === 'PROVISIONING' ? null : WORKTREE,
          initErrorMessage: status === 'FAILED' ? 'git worktree add failed' : null,
          agentSessions: [{ id: 's1' }],
        });
      }
      default:
        return new Response(JSON.stringify({ error: { json: { message: `No ${path}` } } }), {
          status: 404,
        });
    }
  };
  const fetch = (url: string, init: RequestInit) => Promise.resolve(respond(url, init));
  const drive = (timeouts = { request: 1000, ready: 1000, reply: 1000 }) =>
    driveWorkspace({
      origin: ORIGIN,
      repoPath: REPO,
      z,
      fetch,
      openSocket: (url: string) => {
        const socket = new FakeChatSocket(url, frames);
        sockets.push(socket);
        return socket;
      },
      git: (args: string[]) => {
        expect(args).toEqual(['worktree', 'list', '--porcelain']);
        return worktrees
          .map((path) => `worktree ${path}\nHEAD abc\nbranch refs/heads/x\n`)
          .join('\n');
      },
      realpath: (path: string) => path,
      timeouts,
      pollMs: 5,
    });
  return { calls, sockets, drive };
}

describe('driveWorkspace', () => {
  it('creates a workspace with the first prompt and waits for the streamed echo', async () => {
    const server = fakeServer();
    await expect(server.drive()).resolves.toEqual({
      projectId: 'p1',
      workspaceId: 'w1',
      worktreePath: WORKTREE,
      sessionId: 's1',
    });
    expect(server.calls.slice(0, 2)).toEqual([
      { path: 'project.create', origin: ORIGIN, input: { repoPath: REPO } },
      {
        path: 'workspace.create',
        origin: ORIGIN,
        input: {
          type: 'MANUAL',
          projectId: 'p1',
          name: 'packed-consumer-check',
          initialPrompt: FIRST_PROMPT,
          provider: 'CODEX',
        },
      },
    ]);
    // It waited out provisioning of the workspace it created before opening the chat.
    expect(
      server.calls.filter((call) => call.path === 'workspace.get').map((call) => call.input)
    ).toEqual([{ id: 'w1' }, { id: 'w1' }, { id: 'w1' }]);
    const [socket] = server.sockets;
    // No `ffTransport` opt-in: the check works with and without the transport hello.
    expect(new URL(socket?.url ?? '').searchParams.get('sessionId')).toBe('s1');
    expect(socket?.url.startsWith('ws://127.0.0.1:4100/chat?')).toBe(true);
    expect(socket?.url).not.toContain('ffTransport');
    expect(socket?.sent).toEqual([{ type: 'load_session' }]);
  });

  it('finds a reply that finished before the chat connected in the replay', async () => {
    await expect(fakeServer({ frames: REPLAYED_REPLY }).drive()).resolves.toMatchObject({
      sessionId: 's1',
    });
  });

  it('does not take the user message for the reply, and names the step that timed out', async () => {
    await expect(fakeServer({ frames: NO_REPLY }).drive()).rejects.toThrow(
      /^Packed workspace: "wait for the agent reply" timed out after 1000 ms \(frames seen: session_delta, transcript_message_committed/
    );
  });

  it('fails at once when the first prompt fails', async () => {
    await expect(fakeServer({ frames: FAILED_TURN }).drive()).rejects.toThrow(
      'Packed workspace: "wait for the agent reply" failed: The first prompt failed: adapter exited'
    );
  });

  it('reports a failed initialization with its message', async () => {
    await expect(fakeServer({ finalStatus: 'FAILED' }).drive()).rejects.toThrow(
      'Packed workspace: "wait for the workspace to be ready" failed: Workspace initialization failed: git worktree add failed'
    );
  });

  it('names the step when the workspace never becomes ready', async () => {
    await expect(
      fakeServer({ provisioningPolls: Number.POSITIVE_INFINITY }).drive({
        request: 1000,
        ready: 200,
        reply: 1000,
      })
    ).rejects.toThrow(
      'Packed workspace: "wait for the workspace to be ready" timed out after 200 ms'
    );
  });

  it('fails when the workspace worktree is not one of the repository worktrees', async () => {
    await expect(fakeServer({ worktrees: [REPO] }).drive()).rejects.toThrow(
      `Packed workspace: "find the worktree on disk" failed: ${WORKTREE} is not among the repository's worktrees: ${REPO}`
    );
  });

  it('reads the worktree paths from porcelain output', () => {
    expect(
      parseWorktreeList(
        `worktree ${REPO}\nHEAD a\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD b\ndetached\n`
      )
    ).toEqual([REPO, WORKTREE]);
  });
});
