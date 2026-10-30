import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexSessionHistoryLoaderService } from './codex-session-history-loader.service';

function response(
  role: string,
  text: string,
  options: { kinds?: string[]; phase?: string; turnId?: string } = {}
) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      phase: options.phase,
      internal_chat_message_metadata_passthrough:
        options.kinds || options.turnId
          ? {
              turn_id: options.turnId,
              create_time: 1_792_327_289,
              content_item_kinds: options.kinds,
            }
          : undefined,
    },
  };
}

function event(type: string, message?: string, turnId?: string) {
  return { type: 'event_msg', payload: { type, message, turn_id: turnId } };
}

describe('Codex response-item history messages', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-codex-response-history-'));
    vi.stubEnv('CODEX_HOME', tempDir);
    vi.stubEnv('CODEX_SESSIONS_DIR', 'undefined');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function load(entries: unknown[]) {
    const directory = join(tempDir, 'sessions', '2026', '10', '18');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'rollout-response-history.jsonl'),
      [{ type: 'session_meta', payload: { id: 'response-history', cwd: '/tmp/work' } }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    );
    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'response-history',
      workingDir: '/tmp/work',
    });
    expect(result.status).toBe('loaded');
    return result.status === 'loaded' ? result.history : [];
  }

  it('restores native response-only turns and hides injected instructions', async () => {
    const history = await load([
      event('task_started', undefined, 'turn-1'),
      response('developer', 'Developer instructions', { turnId: 'turn-1' }),
      response('user', 'Injected repository and environment instructions', {
        turnId: 'turn-1',
        kinds: ['agents_md.instructions', 'environments.environment_context'],
      }),
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      response('user', 'Say the smoke marker', { turnId: 'turn-1', kinds: ['user.text'] }),
      event('item_completed', undefined, 'turn-1'),
      response('assistant', 'ACP_UI_SMOKE_OK', {
        turnId: 'turn-1',
        phase: 'final_answer',
        kinds: ['unknown'],
      }),
      event('task_complete', undefined, 'turn-1'),
    ]);
    expect(history).toMatchObject([
      { type: 'user', content: 'Say the smoke marker' },
      { type: 'assistant', content: 'ACP_UI_SMOKE_OK' },
    ]);
    expect(history).toHaveLength(2);
  });

  it('deduplicates legacy event copies per turn while retaining upgraded turns and tools in order', async () => {
    const history = await load([
      event('task_started', undefined, 'legacy-turn'),
      response('user', 'Repeat'),
      event('user_message', 'Repeat'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'read',
          call_id: 'call-1',
          arguments: '{"path":"a"}',
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'File' },
      },
      event('agent_message', 'Legacy answer'),
      response('assistant', 'Legacy answer'),
      event('task_complete', undefined, 'legacy-turn'),
      event('task_started', undefined, 'native-turn'),
      response('user', 'Repeat', { kinds: ['user.text'], turnId: 'native-turn' }),
      response('assistant', 'New answer', { phase: 'final_answer', turnId: 'native-turn' }),
      event('task_complete', undefined, 'native-turn'),
      event('task_started', undefined, 'another-legacy-turn'),
      event('user_message', 'Repeat'),
      response('user', 'Repeat'),
      response('assistant', 'Last answer'),
      event('agent_message', 'Last answer'),
    ]);
    expect(history.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'Repeat' },
      { type: 'tool_use', content: '' },
      { type: 'tool_result', content: 'File' },
      { type: 'assistant', content: 'Legacy answer' },
      { type: 'user', content: 'Repeat' },
      { type: 'assistant', content: 'New answer' },
      { type: 'user', content: 'Repeat' },
      { type: 'assistant', content: 'Last answer' },
    ]);
    expect(history[1]).toMatchObject({ toolId: 'call-1', toolInput: { path: 'a' } });
  });

  it('keeps public assistant text and actual user blocks without exposing internal messages', async () => {
    const mixed = response('user', 'unused', { kinds: ['agents_md.instructions', 'user.text'] });
    mixed.payload.content = [
      { type: 'input_text', text: 'Hidden repository instructions' },
      { type: 'input_text', text: 'Actual question' },
    ];
    const history = await load([
      response('system', 'Hidden system instructions'),
      response('developer', 'Hidden developer instructions'),
      mixed,
      response('assistant', 'Hidden reasoning', { phase: 'analysis' }),
      response('assistant', 'Hidden internal content', { phase: 'internal' }),
      response('assistant', 'Public progress', { phase: 'commentary' }),
      response('assistant', 'Public final', { phase: 'final_answer' }),
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'invalid' },
      },
    ]);
    expect(history.map(({ content }) => content)).toEqual([
      'Actual question',
      'Public progress',
      'Public final',
    ]);
  });

  it('supports response-only legacy text and implicit turns without global deduplication', async () => {
    const history = await load([
      response('user', 'First'),
      event('user_message', 'First'),
      event('agent_message', 'First answer'),
      response('assistant', 'First answer'),
      response('user', 'Second'),
      response('assistant', 'Second answer'),
    ]);
    expect(history.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'First' },
      { type: 'assistant', content: 'First answer' },
      { type: 'user', content: 'Second' },
      { type: 'assistant', content: 'Second answer' },
    ]);
  });

  it('hides injected context that legacy rollouts recorded as plain user text', async () => {
    const history = await load([
      response('user', '<user_instructions>\n  Repository rules\n</user_instructions>'),
      response('user', '<environment_context>\n  <cwd>/tmp/work</cwd>\n</environment_context>'),
      response('user', 'Fix the failing test'),
      event('user_message', 'Fix the failing test'),
      response('assistant', 'Done.'),
      event('agent_message', 'Done.'),
      response('user', 'Explain <environment_context> tags'),
      response('assistant', 'Sure.'),
    ]);
    expect(history.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'Fix the failing test' },
      { type: 'assistant', content: 'Done.' },
      { type: 'user', content: 'Explain <environment_context> tags' },
      { type: 'assistant', content: 'Sure.' },
    ]);
  });

  it('keeps a repeated native prompt after a markerless cancelled legacy turn', async () => {
    const history = await load([
      event('user_message', 'Repeat'),
      response('user', 'Repeat', { kinds: ['user.text'], turnId: 'new-native-turn' }),
      response('assistant', 'Native answer', { phase: 'final_answer', turnId: 'new-native-turn' }),
    ]);
    expect(history.map(({ content }) => content)).toEqual(['Repeat', 'Repeat', 'Native answer']);
  });

  it('starts a native turn after markerless legacy history even when the prompt is repeated', async () => {
    const history = await load([
      event('user_message', 'Repeat'),
      event('agent_message', 'Old answer'),
      response('user', 'Repeat', { kinds: ['user.text'], turnId: 'new-native-turn' }),
      response('assistant', 'Native answer', { phase: 'final_answer', turnId: 'new-native-turn' }),
    ]);
    expect(history.map(({ content }) => content)).toEqual([
      'Repeat',
      'Old answer',
      'Repeat',
      'Native answer',
    ]);
  });

  it.each([false, true])(
    'flushes legacy history on native task start with metadata duplicate %s',
    async (duplicate) => {
      const history = await load([
        event('user_message', 'Old prompt'),
        event('agent_message', 'Old answer'),
        ...(duplicate ? [response('assistant', 'Old answer', { turnId: 'old-turn' })] : []),
        event('task_started', undefined, 'native-turn'),
        response('user', 'New prompt', { turnId: 'native-turn', kinds: ['user.text'] }),
        response('assistant', 'Native answer', { turnId: 'native-turn', phase: 'final_answer' }),
      ]);
      expect(history.map(({ content }) => content)).toEqual([
        'Old prompt',
        'Old answer',
        'New prompt',
        'Native answer',
      ]);
    }
  );
});

describe('Codex history image attachments', () => {
  let tempDir: string;
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-codex-image-history-'));
    vi.stubEnv('CODEX_HOME', tempDir);
    vi.stubEnv('CODEX_SESSIONS_DIR', 'undefined');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function load(entries: unknown[]) {
    const directory = join(tempDir, 'sessions', '2026', '10', '29');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'rollout-image-history.jsonl'),
      [{ type: 'session_meta', payload: { id: 'image-history', cwd: '/tmp/work' } }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    );
    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'image-history',
      workingDir: '/tmp/work',
    });
    expect(result.status).toBe('loaded');
    return result.status === 'loaded' ? result.history : [];
  }

  function userResponse(content: unknown[], kinds?: string[]) {
    return {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content,
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
          ...(kinds ? { content_item_kinds: kinds } : {}),
        },
      },
    };
  }

  it('restores native input_image blocks as attachments on the user prompt', async () => {
    const history = await load([
      event('task_started', undefined, 'turn-1'),
      userResponse(
        [
          { type: 'input_text', text: 'Look at this screenshot' },
          { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'high' },
        ],
        ['user.text', 'user.image']
      ),
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: {
            type: 'UserMessage',
            content: [{ type: 'text', text: 'Look at this screenshot' }],
          },
        },
      },
      response('assistant', 'Nice screenshot', { turnId: 'turn-1', phase: 'final_answer' }),
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ type: 'user', content: 'Look at this screenshot' });
    expect(history[0]?.attachments).toEqual([
      {
        id: expect.any(String),
        name: 'image-1.png',
        type: 'image/png',
        contentType: 'image',
        size: 68,
        data: png,
      },
    ]);
  });

  it('restores image-only prompts and skips malformed or non-user images', async () => {
    const history = await load([
      event('task_started', undefined, 'turn-1'),
      userResponse(
        [
          { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' },
          { type: 'input_image', image_url: 'data:text/html;base64,YWJj' },
          { type: 'input_image', image_url: 'https://example.com/image.png' },
          { type: 'input_image', image_url: 'data:image/png;base64,not base64!' },
          { type: 'input_image', image_url: `data:image/png;base64,${png}` },
        ],
        ['user.image', 'user.image', 'user.image', 'user.image', 'environments.screenshot']
      ),
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: 'user', content: '' });
    expect(history[0]?.attachments).toMatchObject([
      { name: 'image-1.jpeg', type: 'image/jpeg', size: 4, data: '/9j/2Q==' },
    ]);
  });

  it('keeps response image attachments when a legacy user_message event replaces the text', async () => {
    const history = await load([
      event('task_started', undefined, 'legacy-turn'),
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Legacy prompt' },
            { type: 'input_image', image_url: `data:image/png;base64,${png}` },
          ],
        },
      },
      event('user_message', 'Legacy prompt'),
      event('agent_message', 'Legacy answer'),
    ]);
    expect(history.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'Legacy prompt' },
      { type: 'assistant', content: 'Legacy answer' },
    ]);
    expect(history[0]?.attachments).toMatchObject([{ type: 'image/png', data: png }]);
  });

  it('restores data URL images from legacy user_message events', async () => {
    const history = await load([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Event prompt',
          images: [`data:image/png;base64,${png}`, 'data:image/png;base64,'],
          local_images: ['/private/tmp/codex/image.png'],
        },
      },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]?.attachments).toMatchObject([{ name: 'image-1.png', data: png }]);
  });
});
