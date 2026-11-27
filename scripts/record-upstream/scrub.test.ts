import { describe, expect, it } from 'vitest';
import knownKeys from './known-keys.json';
import {
  createScrubContext,
  PLACEHOLDER_NUMBER,
  PLACEHOLDER_STRING,
  POLICIES,
  REDACTED,
  scrubArgument,
  scrubCapturedLines,
  scrubRecord,
} from './scrub.mjs';

// Every value here is invented for the test.
const REPOSITORY = '/private/tmp/recorder-test-123/repository';
const HOME = '/Users/someone';

function context() {
  return createScrubContext({
    roots: {
      [REPOSITORY]: '/workspace',
      '/private/tmp/recorder-test-123': '/recording-tmp',
      [HOME]: '/user-home',
    },
  });
}

function promptRequest(text: string) {
  return {
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'abc', prompt: [{ type: 'text', text }] },
  };
}

describe('scrubRecord', () => {
  it('keeps listed structure and replaces every other value with a placeholder of its type', () => {
    const shared = context();
    scrubRecord(promptRequest('hi'), POLICIES.acp, shared, 'client->agent');
    const scrubbed = scrubRecord(
      {
        jsonrpc: '2.0',
        id: 3,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 12, seats: 42 },
          label: 'Personal plan',
          active: true,
          content: { text: 'anything', missing: null },
          accountLabel: 'x',
          planLabel: 'y',
        },
      },
      POLICIES.acp,
      shared,
      'agent->client'
    );
    expect(scrubbed).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 12, '<key>': PLACEHOLDER_NUMBER },
        label: PLACEHOLDER_STRING,
        active: true,
        content: { text: PLACEHOLDER_STRING, '<key>': null },
        '<key>': PLACEHOLDER_STRING,
        '<key-2>': PLACEHOLDER_STRING,
      },
    });
  });

  it('maps ids and timestamps to fixed fakes that stay consistent across records', () => {
    const shared = context();
    const uuid = '3f2b8c1e-9a7d-4e6f-b5c4-1d2e3f4a5b6c';
    const first = scrubRecord(
      {
        type: 'assistant',
        uuid,
        timestamp: '2026-05-01T10:00:00.123Z',
        message: { id: 'msg_01AbCdEfGhIjKlMnOpQrStUv', content: [] },
        toolCallId: 'exec-9c8b7a6f-5e4d-4c3b-a291-807f6e5d4c3b',
      },
      POLICIES.claudeHistory,
      shared
    );
    const second = scrubRecord(
      { type: 'user', parentUuid: uuid, timestamp: '2026-05-01T10:00:00.123Z' },
      POLICIES.claudeHistory,
      shared
    );
    expect(first.uuid).toBe('00000000-0000-4000-8000-000000000001');
    expect(second.parentUuid).toBe(first.uuid);
    expect(first.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(second.timestamp).toBe(first.timestamp);
    expect(first.message.id).toMatch(/^msg_0+Fake1$/);
    expect(first.message.id).toHaveLength('msg_01AbCdEfGhIjKlMnOpQrStUv'.length);
    expect(first.toolCallId).toBe('exec-00000000-0000-4000-8000-000000000002');
  });

  it('fakes ids used as object keys and leaves word keys alone', () => {
    const scrubbed = scrubRecord(
      {
        type: 'assistant',
        wireToolInputs: { toolu_01AbCdEfGhIjKlMnOpQrStUv: { command: 'ls' } },
        message: { input_transformations: [] },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(Object.keys(scrubbed.wireToolInputs)[0]).toMatch(/^toolu_0+Fake1$/);
    expect(scrubbed.message).toEqual({ input_transformations: [] });
  });

  it('keeps conversation text in conversation records and rewrites known paths', () => {
    const scrubbed = scrubRecord(
      promptRequest(`Read ${REPOSITORY}/notes.txt and ${HOME}/elsewhere/file`),
      POLICIES.acp,
      context()
    );
    expect(scrubbed.params.prompt[0].text).toBe(
      'Read /workspace/notes.txt and /user-home/elsewhere/file'
    );
  });

  it('rewrites the encoded project directory name Claude derives from the cwd', () => {
    const scrubbed = scrubRecord(
      {
        type: 'user',
        message: {
          content: `see ${HOME}/.claude/projects/-private-tmp-recorder-test-123-repository/a.jsonl`,
        },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(scrubbed.message.content).toBe('see /user-home/.claude/projects/-workspace/a.jsonl');
  });

  it('drops text from records that are not conversation', () => {
    const scrubbed = scrubRecord(
      {
        type: 'attachment',
        attachment: { type: 'session_context', content: 'The user is Jane at a lab.' },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(scrubbed.attachment).toEqual({ type: 'session_context', content: PLACEHOLDER_STRING });
  });

  it('keeps only discriminators in opaque records', () => {
    const scrubbed = scrubRecord(
      {
        type: 'system',
        subtype: 'init',
        model: 'model-name',
        tools: ['Bash', 'Read'],
        cwd: `${REPOSITORY}`,
      },
      POLICIES.claudeStdio,
      context()
    );
    expect(scrubbed).toEqual({
      type: 'system',
      subtype: 'init',
      model: PLACEHOLDER_STRING,
      tools: [PLACEHOLDER_STRING, PLACEHOLDER_STRING],
      cwd: '/workspace',
    });
  });

  it('redacts conversation text that still looks private and counts it', () => {
    const shared = context();
    const scrubbed = scrubRecord(
      promptRequest('mail jane.doe@example.org please'),
      POLICIES.acp,
      shared
    );
    expect(scrubbed.params.prompt[0].text).toBe(REDACTED);
    expect(shared.redactions).toBe(1);
  });

  it('never keeps a structural value that looks private', () => {
    const scrubbed = scrubRecord(
      { type: 'jane.doe@example.org', name: 'sk-abcdefghijklmnopqrst' },
      POLICIES.acp,
      context()
    );
    expect(scrubbed).toEqual({ type: PLACEHOLDER_STRING, name: PLACEHOLDER_STRING });
  });

  it('replaces rate-limit and account figures in app-server responses', () => {
    const scrubbed = scrubCapturedLines(
      [
        { dir: 'client->server', line: JSON.stringify({ id: 2, method: 'account/read' }) },
        {
          dir: 'server->client',
          line: JSON.stringify({
            id: 2,
            result: {
              account: { type: 'chatgpt', email: 'jane.doe@example.org', planType: 'team' },
            },
          }),
        },
        {
          dir: 'client->server',
          line: JSON.stringify({ id: 3, method: 'account/rateLimits/read' }),
        },
        {
          dir: 'server->client',
          line: JSON.stringify({
            id: 3,
            result: {
              rateLimits: {
                primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_790_000_000 },
              },
            },
          }),
        },
      ],
      POLICIES.codexAppServer,
      context()
    );
    expect(scrubbed[1]?.message).toEqual({
      id: 2,
      result: {
        account: { type: 'chatgpt', email: PLACEHOLDER_STRING, planType: PLACEHOLDER_STRING },
      },
    });
    expect(scrubbed[3]?.message).toEqual({
      id: 3,
      result: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 } } },
    });
  });

  it('scrubs a response by the request it answers in the other direction', () => {
    const shared = context();
    // Both sides number their own requests from 0.
    const lines = scrubCapturedLines(
      [
        { dir: 'client->agent', line: JSON.stringify({ id: 0, method: 'initialize' }) },
        {
          dir: 'agent->client',
          line: JSON.stringify({ id: 0, method: 'session/request_permission', params: {} }),
        },
        {
          dir: 'client->agent',
          line: JSON.stringify({
            id: 0,
            result: { outcome: { outcome: 'selected', optionId: 'a' } },
          }),
        },
        {
          dir: 'agent->client',
          line: JSON.stringify({ id: 0, result: { agentInfo: { name: 'agent' } } }),
        },
      ],
      POLICIES.acp,
      shared
    );
    expect(lines[2]?.message).toEqual({
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'a' } },
    });
    expect(lines[3]?.message).toEqual({ id: 0, result: { agentInfo: { name: 'agent' } } });
  });
});

describe('scrubCapturedLines', () => {
  it('joins multi-line output, keeps flag names and drops argument values', () => {
    const scrubbed = scrubCapturedLines(
      [
        { dir: 'argv', args: ['auth', 'status', '--json', '--session-id=abc', '{"x":1}'] },
        { dir: 'cli->sdk', line: '{' },
        { dir: 'cli->sdk', line: '  "loggedIn": true,' },
        { dir: 'cli->sdk', line: '  "email": "jane.doe@example.org"' },
        { dir: 'cli->sdk', line: '}' },
        { dir: 'cli->sdk', line: '{"type":"system","subtype":"status"}' },
        { dir: 'cli->sdk', line: 'not json at all' },
      ],
      POLICIES.claudeStdio,
      context()
    );
    expect(scrubbed).toEqual([
      { dir: 'argv', args: ['auth', 'status', '--json', '--session-id', PLACEHOLDER_STRING] },
      { dir: 'cli->sdk', message: { loggedIn: true, email: PLACEHOLDER_STRING } },
      { dir: 'cli->sdk', message: { type: 'system', subtype: 'status' } },
      { dir: 'cli->sdk', message: PLACEHOLDER_STRING },
    ]);
  });

  it('keeps plain words and replaces paths among CLI arguments', () => {
    expect(scrubArgument('stream-json')).toBe('stream-json');
    expect(scrubArgument(`${REPOSITORY}/x`)).toBe(PLACEHOLDER_STRING);
  });
});

describe('POLICIES', () => {
  it('name keep, text, numbers and maps paths for every kind and a kind for every record', () => {
    for (const policy of Object.values(POLICIES)) {
      expect(typeof policy.kindOf).toBe('function');
      for (const kind of [policy.common, ...Object.values(policy.kinds)]) {
        expect(Object.keys(kind).sort()).toEqual(['ids', 'keep', 'maps', 'numbers', 'text']);
      }
    }
  });

  it('name only field names the key allowlist knows', () => {
    const known = new Set(knownKeys);
    for (const policy of Object.values(POLICIES)) {
      for (const kind of [policy.common, ...Object.values(policy.kinds)]) {
        const paths: string[] = [
          ...kind.keep,
          ...kind.ids,
          ...kind.text,
          ...kind.numbers,
          ...kind.maps,
        ];
        for (const path of paths) {
          for (const segment of path.split(/[.>]/).filter((part) => part && part !== '*')) {
            expect(known.has(segment), `${path}: ${segment}`).toBe(true);
          }
        }
      }
    }
  });
});

// Inputs from the review of the first recordings: values a later CLI version
// could add, none of which may survive without being named in an allowlist.
describe('values that are not allowlisted', () => {
  const asJson = (value: unknown) => JSON.stringify(value);

  it('treats a record type it does not know as opaque', () => {
    const scrubbed = scrubRecord(
      { type: 'account_snapshot', name: 'Jane Doe', id: 'acct-42x' },
      POLICIES.claudeStdio,
      context()
    );
    expect(scrubbed).toEqual({
      type: 'account_snapshot',
      name: PLACEHOLDER_STRING,
      id: PLACEHOLDER_STRING,
    });
  });

  it('drops values and numbers of an unknown ACP notification', () => {
    const scrubbed = scrubRecord(
      {
        jsonrpc: '2.0',
        method: '_claude/account',
        params: {
          title: 'Jane',
          value: 'Acme',
          currentValue: 'x',
          name: 'Jane Doe',
          account: { id: 123_456_789 },
        },
      },
      POLICIES.acp,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/Jane|Acme|"x"|123456789/);
  });

  it('drops a new field in a known app-server response', () => {
    const scrubbed = scrubCapturedLines(
      [
        {
          dir: 'client->server',
          line: asJson({ id: 2, method: 'account/read', params: { refreshToken: false } }),
        },
        {
          dir: 'server->client',
          line: asJson({
            id: 2,
            result: {
              account: { type: 'chatgpt', workspace: { name: 'Acme', displayName: 'Acme Inc' } },
              credits: { limit: 250 },
            },
          }),
        },
      ],
      POLICIES.codexAppServer,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/Acme|250/);
    expect(asJson(scrubbed)).toContain('"chatgpt"');
  });

  it('drops a new field in a conversation record and keeps the conversation text', () => {
    const scrubbed = scrubRecord(
      {
        type: 'user',
        context: { description: 'Jane at Acme' },
        message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/Jane|Acme/);
    expect(scrubbed.message.content[0].text).toBe('hello there');
  });

  it('scrubs JSON carried inside conversation text', () => {
    const scrubbed = scrubRecord(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
              content: '{"login":"jane-doe","org":"Acme"}',
            },
          ],
        },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/jane|Acme/);
  });

  it('drops a known key that appears where it is not listed', () => {
    const scrubbed = scrubRecord(
      { type: 'system', subtype: 'status', tools: [['Bash', 'jane-doe']] },
      POLICIES.claudeStdio,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/Bash|jane/);
  });

  it('replaces object keys that carry data, in opaque records too', () => {
    const scrubbed = scrubRecord(
      {
        type: 'system',
        subtype: 'init',
        projects: { '/Volumes/Work/acme-secret': {} },
        modelUsage: { 'acme-finetune-jane': {} },
      },
      POLICIES.claudeStdio,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/acme|Volumes/);
  });

  it('keeps only paths under the repository, the temp root and the Claude project directory', () => {
    const scrubbed = scrubRecord(
      {
        type: 'user',
        cwd: `${HOME}/Clients/Acme/secret`,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(asJson(scrubbed)).not.toMatch(/Clients|Acme/);
  });

  it('redacts conversation text holding credentials or temp paths in any spelling', () => {
    for (const secret of [
      'use bearer abc123def',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'xoxb-1234567890-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'see /private/var/folders/xy/abc/T/other',
      'see %2FUsers%2Fsomeone%2Fx',
    ]) {
      const scrubbed = scrubRecord(promptRequest(secret), POLICIES.acp, context());
      expect(scrubbed.params.prompt[0].text, secret).toBe(REDACTED);
    }
  });

  it('does not keep an id prefix it does not know', () => {
    const scrubbed = scrubRecord(
      { type: 'assistant', message: { id: 'janedoe_0123456789abcdef', content: [] } },
      POLICIES.claudeHistory,
      context()
    );
    expect(asJson(scrubbed)).not.toContain('janedoe');
  });
});

// Inputs from the second review round.
describe('paths, opaque discriminators and random ids', () => {
  const commandsUpdate = (skillPath: string) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'abc',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'x', _meta: { jetbrains: { air: { version: 1, skillPath } } } },
        ],
      },
    },
  });
  const skillPathOf = (record: ReturnType<typeof commandsUpdate>) =>
    record.params.update.availableCommands[0]?._meta.jetbrains.air.skillPath;

  it('drops a kept absolute path outside the approved roots', () => {
    const scrubbed = scrubRecord(
      commandsUpdate('/opt/acme/skills/SKILL.md'),
      POLICIES.acp,
      context()
    );
    expect(skillPathOf(scrubbed)).toBe(PLACEHOLDER_STRING);
  });

  it('keeps a kept path inside an approved root after normalising it', () => {
    const scrubbed = scrubRecord(
      commandsUpdate(`${REPOSITORY}/sub/../skills/SKILL.md`),
      POLICIES.acp,
      context()
    );
    expect(skillPathOf(scrubbed)).toBe('/workspace/skills/SKILL.md');
  });

  it('rejects a path that escapes an approved root with ..', () => {
    const escaped = scrubRecord(
      commandsUpdate(`${REPOSITORY}/../../../etc/passwd`),
      POLICIES.acp,
      context()
    );
    const cwd = scrubRecord(
      {
        type: 'user',
        cwd: `${REPOSITORY}/../../../etc/secret`,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      POLICIES.claudeHistory,
      context()
    );
    expect(skillPathOf(escaped)).toBe(PLACEHOLDER_STRING);
    expect(cwd.cwd).toBe(PLACEHOLDER_STRING);
  });

  it('keeps discriminators of an opaque record at its top level only', () => {
    const scrubbed = scrubRecord(
      {
        type: 'account_snapshot',
        profile: {
          status: 'jdoe-acme-laptop',
          kind: 'acme.corp/team-red',
          role: 'org:acme-admin',
        },
      },
      POLICIES.claudeStdio,
      context()
    );
    expect(scrubbed.type).toBe('account_snapshot');
    expect(JSON.stringify(scrubbed)).not.toMatch(/jdoe|acme/);
  });

  it('maps a request id to the same stable fake in the request and its response', () => {
    const scrubbed = scrubCapturedLines(
      [
        {
          dir: 'sdk->cli',
          line: JSON.stringify({
            type: 'control_request',
            request_id: 'q7x2k9w1',
            request: { subtype: 'interrupt' },
          }),
        },
        {
          dir: 'cli->sdk',
          line: JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'q7x2k9w1' },
          }),
        },
      ],
      POLICIES.claudeStdio,
      context()
    );
    expect(JSON.stringify(scrubbed)).not.toContain('q7x2k9w1');
    expect(scrubbed[0]?.message.request_id).toMatch(/^fake-\d+$/);
    expect(scrubbed[1]?.message.response.request_id).toBe(scrubbed[0]?.message.request_id);
  });

  it('keeps the model names of Claude cost totals and zeroes the figures', () => {
    const scrubbed = scrubRecord(
      { type: 'cost-state', modelUsage: { 'claude-model-1': { inputTokens: 12, costUSD: 3 } } },
      POLICIES.claudeHistory,
      context()
    );
    expect(scrubbed.modelUsage).toEqual({
      'claude-model-1': { inputTokens: 0, costUSD: 0 },
    });
  });

  it('keeps the shape of Codex tool output with a fake chunk id', () => {
    const scrubbed = scrubRecord(
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: '126bb7',
                wall_time_seconds: 0.25,
                original_token_count: 14,
                output: 'ok',
              }),
            },
          ],
        },
      },
      POLICIES.codexRollout,
      context()
    );
    expect(JSON.parse(scrubbed.payload.output[0].text)).toEqual({
      chunk_id: expect.stringMatching(/^fake-\d+$/),
      wall_time_seconds: 0.25,
      original_token_count: 14,
      output: 'ok',
    });
  });
});

describe('the Codex rollout policy', () => {
  it('keeps user text and drops developer instructions', () => {
    const shared = context();
    const user = scrubRecord(
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      },
      POLICIES.codexRollout,
      shared
    );
    const developer = scrubRecord(
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'secret rules' }],
        },
      },
      POLICIES.codexRollout,
      shared
    );
    expect(user.payload.content[0].text).toBe('hi');
    expect(developer.payload.content[0].text).toBe(PLACEHOLDER_STRING);
  });

  it('keeps the role, block types and content item kinds a history loader reads', () => {
    const shared = context();
    const message = (role: string) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        content: [{ type: 'input_text', text: 'secret rules' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['user.text'],
          content_item_metadata: [{ provenance: { type: 'harness' } }],
        },
      },
    });
    for (const role of ['user', 'developer']) {
      const { payload } = scrubRecord(message(role), POLICIES.codexRollout, shared);
      expect(payload.role).toBe(role);
      expect(payload.content[0].type).toBe('input_text');
      expect(payload.internal_chat_message_metadata_passthrough).toEqual({
        content_item_kinds: ['user.text'],
        content_item_metadata: [{ provenance: { type: 'harness' } }],
      });
    }
  });

  it('keeps the JSON Schema types of extra tools, not their names or descriptions', () => {
    const { payload } = scrubRecord(
      {
        type: 'response_item',
        payload: {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'private_namespace',
              tools: [
                {
                  type: 'function',
                  name: 'private_tool',
                  description: 'private description',
                  parameters: {
                    type: 'object',
                    properties: { private_field: { type: 'array', items: { type: 'string' } } },
                  },
                },
              ],
            },
          ],
        },
      },
      POLICIES.codexRollout,
      context()
    );
    expect(payload.role).toBe('developer');
    expect(payload.tools[0].type).toBe('namespace');
    expect(payload.tools[0].tools[0].parameters).toEqual({
      type: 'object',
      properties: { '<key>': { type: 'array', items: { type: 'string' } } },
    });
    expect(JSON.stringify(payload)).not.toContain('private');
  });

  it('treats world state as opaque and session instructions as unlisted', () => {
    const shared = context();
    const world = scrubRecord(
      {
        type: 'world_state',
        payload: { state: { model: { model: 'm', instructions: 'private' } } },
      },
      POLICIES.codexRollout,
      shared
    );
    const meta = scrubRecord(
      {
        type: 'session_meta',
        payload: { cwd: REPOSITORY, cli_version: '1.2.3', base_instructions: { text: 'private' } },
      },
      POLICIES.codexRollout,
      shared
    );
    expect(JSON.stringify(world)).not.toContain('private');
    expect(meta.payload).toEqual({
      cwd: '/workspace',
      cli_version: '1.2.3',
      base_instructions: { text: PLACEHOLDER_STRING },
    });
  });

  it('keeps the command of a function call and drops unknown argument fields', () => {
    const scrubbed = scrubRecord(
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_0123456789abcdef',
          arguments: JSON.stringify({ cmd: 'ls', workdir: REPOSITORY, account: 'jane' }),
        },
      },
      POLICIES.codexRollout,
      context()
    );
    const args = JSON.parse(scrubbed.payload.arguments);
    expect(args.cmd).toBe('ls');
    expect(args.workdir).toBe('/workspace');
    expect(JSON.stringify(args)).not.toContain('jane');
  });
});
