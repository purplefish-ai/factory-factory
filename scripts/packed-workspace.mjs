// Drives one workspace through the packed server the way the browser does:
// tRPC over HTTP creates the project and the workspace and reads its state,
// and the chat WebSocket carries the agent's reply. `z` is the installed
// package's Zod, so the check uses the dependencies it ships.
//
// The provider is the scripted fake Codex app-server playing the `echo`
// scenario, so the agent's reply to the first prompt is the prompt itself.
// Every wait is bounded and its failure names the step.
//
// The chat socket does not opt in to the `ffTransport` hello and pings; frames
// it does not know are ignored.

export const FIRST_PROMPT = 'Packed consumer check: reply with this prompt';

const DEFAULT_TIMEOUTS = {
  /** One tRPC request. */
  request: 15_000,
  /** The worktree added and the workspace READY. */
  ready: 60_000,
  /** The agent's reply on the chat socket, from connecting. */
  reply: 60_000,
};

/**
 * Runs `work`, which must settle when its signal aborts. The signal aborts
 * after `ms` with an error naming the step; any other failure is named too.
 */
async function step(name, ms, work) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Packed workspace: "${name}" timed out after ${ms} ms`)),
    ms
  );
  try {
    return await work(controller.signal);
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('Packed workspace:')) {
      throw new Error(`Packed workspace: "${name}" failed: ${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The worktree paths `git worktree list --porcelain` prints. */
export function parseWorktreeList(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function createTrpc({ origin, fetch, z }) {
  const success = z.object({ result: z.object({ data: z.object({ json: z.unknown() }) }) });
  const failure = z.object({
    error: z.object({ json: z.object({ message: z.string() }) }),
  });
  const headers = { origin, 'content-type': 'application/json' };
  async function call(path, init) {
    const response = await fetch(`${origin}/api/trpc/${path}`, { ...init, headers });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${path} answered HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = success.safeParse(body);
    if (response.ok && parsed.success) {
      return parsed.data.result.data.json;
    }
    const error = failure.safeParse(body);
    const detail = error.success ? error.data.error.json.message : text.slice(0, 500);
    throw new Error(`${path} answered HTTP ${response.status}: ${detail}`);
  }
  return {
    mutation: (path, input, signal) =>
      call(path, { method: 'POST', body: JSON.stringify({ json: input }), signal }),
    query: (path, input, signal) =>
      call(`${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
        method: 'GET',
        signal,
      }),
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * Follows the chat frames that can carry the agent's text, live or replayed,
 * and reports when an assistant message reads exactly `prompt`.
 */
export function createReplyWatcher({ z, prompt }) {
  const content = z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() })),
  ]);
  const agentMessage = z.object({
    type: z.string(),
    message: z.object({ role: z.string(), content }).optional(),
    is_error: z.boolean().optional(),
    error: z.string().optional(),
  });
  const frame = z.object({ type: z.string() });
  const shapes = {
    agent_message: z.object({ data: agentMessage }),
    assistant_text_delta: z.object({ messageId: z.string(), offset: z.number(), text: z.string() }),
    session_snapshot: z.object({
      messages: z.array(z.object({ source: z.string(), message: agentMessage.optional() })),
    }),
    session_delta: z.object({ data: z.unknown() }),
    session_replay_batch: z.object({ replayEvents: z.array(z.unknown()).optional() }),
    session_replay_chunk: z.object({
      encoding: z.string().optional(),
      replayEvents: z.array(z.unknown()).optional(),
      batch: z.object({ replayEvents: z.array(z.unknown()).optional() }).optional(),
    }),
    message_state_changed: z.object({
      newState: z.string(),
      errorMessage: z.string().optional(),
    }),
    error: z.object({ message: z.string() }),
  };
  const streamed = new Map();
  const seen = [];
  const matches = (text) => text.trim() === prompt;
  const textOf = (message) => {
    if (message.type !== 'assistant' || message.message === undefined) {
      return null;
    }
    const body = message.message.content;
    return typeof body === 'string'
      ? body
      : body.flatMap((item) => (item.type === 'text' && item.text ? [item.text] : [])).join('');
  };

  function accept(event) {
    const { type } = frame.parse(event);
    seen.push(type);
    switch (type) {
      case 'agent_message': {
        const { data } = shapes.agent_message.parse(event);
        if (data.type === 'result' && data.is_error) {
          throw new Error(`The agent turn failed: ${data.error ?? JSON.stringify(data)}`);
        }
        const text = textOf(data);
        return text !== null && matches(text);
      }
      case 'assistant_text_delta': {
        const delta = shapes.assistant_text_delta.parse(event);
        const text = (streamed.get(delta.messageId) ?? '').slice(0, delta.offset) + delta.text;
        streamed.set(delta.messageId, text);
        return matches(text);
      }
      case 'session_snapshot':
        return shapes.session_snapshot.parse(event).messages.some((message) => {
          const text = message.source === 'agent' && message.message && textOf(message.message);
          return Boolean(text) && matches(text);
        });
      case 'session_delta':
        return accept(shapes.session_delta.parse(event).data);
      case 'session_replay_batch':
        return acceptAll(shapes.session_replay_batch.parse(event).replayEvents);
      case 'session_replay_chunk': {
        const chunk = shapes.session_replay_chunk.parse(event);
        if (chunk.encoding !== 'events') {
          // Only a replay larger than one frame is split into bytes; this one is a few messages.
          throw new Error(`Unexpected byte-fragmented replay (encoding ${chunk.encoding})`);
        }
        return acceptAll(chunk.batch?.replayEvents) || acceptAll(chunk.replayEvents);
      }
      case 'message_state_changed': {
        const change = shapes.message_state_changed.parse(event);
        if (change.newState === 'FAILED') {
          throw new Error(`The first prompt failed: ${change.errorMessage ?? 'no error message'}`);
        }
        return false;
      }
      case 'error':
        throw new Error(`Chat error: ${shapes.error.parse(event).message}`);
      default:
        return false;
    }
  }
  function acceptAll(events = []) {
    let found = false;
    for (const event of events) {
      found = accept(event) || found;
    }
    return found;
  }
  return { accept, seen };
}

/** Opens the chat socket for `sessionId`, loads the session and waits for the echo. */
function waitForReply({ origin, sessionId, z, openSocket, prompt }, signal) {
  const query = new URLSearchParams({ sessionId, connectionId: `packed-check-${Date.now()}` });
  const socket = openSocket(`${origin.replace(/^http/, 'ws')}/chat?${query}`);
  const watcher = createReplyWatcher({ z, prompt });
  return new Promise((done, fail) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        socket.terminate();
        fail(error);
      } else {
        // A clean close: the server is not left writing to a dropped socket.
        socket.close(1000);
        done(watcher.seen);
      }
    };
    signal.addEventListener(
      'abort',
      () =>
        finish(new Error(`${signal.reason?.message} (frames seen: ${watcher.seen.join(', ')})`)),
      { once: true }
    );
    socket.on('open', () => socket.send(JSON.stringify({ type: 'load_session' })));
    socket.on('error', finish);
    socket.on('close', () => finish(new Error('Chat socket closed before the reply')));
    socket.on('message', (data) => {
      try {
        if (watcher.accept(JSON.parse(data.toString()))) {
          finish();
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

/**
 * Creates a project for `repoPath` and a workspace with the first prompt, then
 * checks the workspace is READY, the agent replied on the chat socket and the
 * workspace's worktree is one of the repository's on disk.
 *
 * `fetch` and `openSocket(url)` reach the server; `git(args)` runs in the
 * repository and `realpath` resolves a path that exists.
 */
export async function driveWorkspace({
  origin,
  repoPath,
  z,
  fetch,
  openSocket,
  git,
  realpath,
  prompt = FIRST_PROMPT,
  timeouts = DEFAULT_TIMEOUTS,
  pollMs = 250,
  log: write = () => undefined,
}) {
  const started = Date.now();
  const log = (line) =>
    write(`[workspace +${((Date.now() - started) / 1000).toFixed(1)} s] ${line}`);
  const trpc = createTrpc({ origin, fetch, z });
  const created = z.object({ id: z.string() });

  const project = await step('create the project', timeouts.request, (signal) =>
    trpc.mutation('project.create', { repoPath }, signal).then((data) => created.parse(data))
  );
  log(`Created project ${project.id} for ${repoPath}`);

  const workspace = await step('create the workspace', timeouts.request, (signal) =>
    trpc
      .mutation(
        'workspace.create',
        {
          type: 'MANUAL',
          projectId: project.id,
          name: 'packed-consumer-check',
          initialPrompt: prompt,
          provider: 'CODEX',
        },
        signal
      )
      .then((data) => created.parse(data))
  );
  log(`Created workspace ${workspace.id}`);

  const detail = z.object({
    status: z.string(),
    worktreePath: z.string().nullable(),
    initErrorMessage: z.string().nullable().optional(),
    agentSessions: z.array(z.object({ id: z.string() })),
  });
  const ready = await step('wait for the workspace to be ready', timeouts.ready, async (signal) => {
    let last = 'no answer yet';
    for (;;) {
      const state = detail.parse(await trpc.query('workspace.get', { id: workspace.id }, signal));
      if (state.status === 'FAILED') {
        throw new Error(
          `Workspace initialization failed: ${state.initErrorMessage ?? 'no message'}`
        );
      }
      const [session] = state.agentSessions;
      if (state.status === 'READY' && state.worktreePath && session) {
        return { worktreePath: state.worktreePath, sessionId: session.id };
      }
      const next = `status ${state.status}, ${state.agentSessions.length} sessions`;
      if (next !== last) {
        log(`Workspace ${next}`);
        last = next;
      }
      await delay(pollMs, signal);
    }
  });
  log(`Workspace READY in ${ready.worktreePath}`);

  const frames = await step('wait for the agent reply', timeouts.reply, (signal) =>
    waitForReply({ origin, sessionId: ready.sessionId, z, openSocket, prompt }, signal)
  );
  log(`The agent replied to the first prompt (chat frames: ${[...new Set(frames)].join(', ')})`);

  await step('find the worktree on disk', timeouts.request, async () => {
    const worktree = realpath(ready.worktreePath);
    const listed = parseWorktreeList(git(['worktree', 'list', '--porcelain'])).map((path) =>
      realpath(path)
    );
    if (!listed.includes(worktree)) {
      throw new Error(`${worktree} is not among the repository's worktrees: ${listed.join(', ')}`);
    }
  });
  log(`The worktree is registered with the repository`);
  return { projectId: project.id, workspaceId: workspace.id, ...ready };
}
