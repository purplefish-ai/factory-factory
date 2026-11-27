import { describe, expect, it } from 'vitest';
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
    const scrubbed = scrubRecord(
      {
        jsonrpc: '2.0',
        id: 7,
        result: {
          stopReason: 'end_turn',
          accountLabel: 'Personal plan',
          seats: 42,
          active: true,
          nested: { note: 'anything', missing: null },
        },
      },
      POLICIES.acp,
      context()
    );
    expect(scrubbed).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        stopReason: 'end_turn',
        accountLabel: PLACEHOLDER_STRING,
        seats: PLACEHOLDER_NUMBER,
        active: true,
        nested: { note: PLACEHOLDER_STRING, missing: null },
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
    const scrubbed = scrubRecord(
      {
        id: 3,
        result: {
          account: { type: 'chatgpt', email: 'jane.doe@example.org', planType: 'team' },
          rateLimits: {
            primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_790_000_000 },
          },
        },
      },
      POLICIES.codexAppServer,
      context()
    );
    expect(scrubbed).toEqual({
      id: 3,
      result: {
        account: { type: 'chatgpt', email: PLACEHOLDER_STRING, planType: PLACEHOLDER_STRING },
        rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 } },
      },
    });
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
  it('declare keep, text and numbers allowlists and a text gate for every stream', () => {
    for (const policy of Object.values(POLICIES)) {
      expect(policy.keep).toBeInstanceOf(Set);
      expect(policy.text).toBeInstanceOf(Set);
      expect(policy.numbers).toBeInstanceOf(Set);
      expect(typeof policy.allowsText).toBe('function');
    }
  });
});
