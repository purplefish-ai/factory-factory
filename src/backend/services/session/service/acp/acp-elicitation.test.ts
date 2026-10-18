import type { CreateElicitationRequest, ElicitationSchema } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { getAskUserQuestions } from '@/shared/acp-protocol/question-input';
import { AcpClientHandler } from './acp-client-handler';
import { AcpPermissionBridge } from './acp-permission-bridge';

function form(requestedSchema: ElicitationSchema): CreateElicitationRequest {
  return { mode: 'form', sessionId: 'provider-1', message: 'Choose settings', requestedSchema };
}

function setup() {
  const onEvent = vi.fn();
  const bridge = new AcpPermissionBridge();
  const handler = new AcpClientHandler('db-1', onEvent, bridge);
  return { handler, bridge, onEvent };
}

describe('ACP elicitation', () => {
  it.each(['', '   ', '__other__'])(
    'preserves blank choice values %j through the question UI',
    async (value) => {
      const { handler, bridge, onEvent } = setup();
      const response = handler.createElicitation(
        form({
          properties: { choice: { type: 'string', enum: [value, 'normal'] } },
          required: ['choice'],
        })
      );
      const event = onEvent.mock.calls[0]![1];
      const questions = getAskUserQuestions(event.params.toolCall.rawInput);
      expect(questions).toHaveLength(1);
      const option = questions[0]!.options[0]!;
      expect(option.label.trim().length).toBeGreaterThan(0);
      bridge.resolvePermission(event.requestId, 'accept', {
        choice: [option.value ?? option.label],
      });
      await expect(response).resolves.toEqual({ action: 'accept', content: { choice: value } });
    }
  );

  it('preserves blank array choices and avoids transport-token collisions', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: {
          choices: {
            type: 'array',
            items: { type: 'string', enum: ['', '__elicitation_option_0__'] },
          },
        },
        required: ['choices'],
      })
    );
    const event = onEvent.mock.calls[0]![1];
    const question = getAskUserQuestions(event.params.toolCall.rawInput)[0]!;
    bridge.resolvePermission(event.requestId, 'accept', {
      choices: question.options.map((option) => option.value ?? option.label),
    });
    await expect(response).resolves.toEqual({
      action: 'accept',
      content: { choices: ['', '__elicitation_option_0__'] },
    });
  });

  it('renders upstream question forms and returns typed field values', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: {
          color: {
            type: 'string',
            title: 'Which color?',
            oneOf: [{ const: 'blue', title: 'Blue' }],
          },
          count: { type: 'integer', minimum: 1, maximum: 5 },
          ratio: { type: 'number' },
          enabled: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 },
          note: { type: 'string' },
        },
        required: ['color', 'count', 'ratio', 'enabled', 'tags'],
      })
    );
    const event = onEvent.mock.calls[0]![1];
    expect(event.params.toolCall.title).toBe('AskUserQuestion');
    expect(event.params.toolCall.rawInput).toMatchObject({
      questions: [
        {
          id: 'color',
          question: 'Which color?',
          options: [{ label: 'blue', description: 'Blue' }],
        },
        { id: 'count', question: 'count' },
        { id: 'ratio', question: 'ratio' },
        { id: 'enabled', options: [{ label: 'true' }, { label: 'false' }] },
        { id: 'tags', multiSelect: true },
        { id: 'note' },
      ],
    });
    bridge.resolvePermission(event.requestId, 'accept', {
      color: ['blue'],
      count: ['3'],
      ratio: ['0.5'],
      enabled: ['false'],
      tags: ['a', 'b'],
    });
    await expect(response).resolves.toEqual({
      action: 'accept',
      content: { color: 'blue', count: 3, ratio: 0.5, enabled: false, tags: ['a', 'b'] },
    });
  });

  it.each([
    { type: 'string' as const, enum: ['A'] },
    { type: 'string' as const, oneOf: [{ const: 'A', title: 'A' }] },
  ])('accepts native Other answers when upstream metadata permits them %#', async (choice) => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: { choice: { ...choice, _meta: { codex: { isOther: true } } } },
        required: ['choice'],
      })
    );
    const event = onEvent.mock.calls[0]![1];
    expect(event.params.toolCall.rawInput.questions[0]).toMatchObject({
      id: 'choice',
      allowOther: true,
    });
    bridge.resolvePermission(event.requestId, 'accept', { choice: ['My own answer'] });
    await expect(response).resolves.toEqual({
      action: 'accept',
      content: { choice: 'My own answer' },
    });
  });

  it('hides unsupported Other answers for strict form choices', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: {
          choice: { type: 'string', enum: ['A'] },
          enabled: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string', enum: ['a'] } },
        },
      })
    );
    const event = onEvent.mock.calls[0]![1];
    expect(event.params.toolCall.rawInput.questions).toEqual([
      expect.objectContaining({ id: 'choice', allowOther: false }),
      expect.objectContaining({ id: 'enabled', allowOther: false }),
      expect.objectContaining({ id: 'tags', allowOther: false }),
    ]);
    bridge.cancelAll();
    await expect(response).resolves.toEqual({ action: 'cancel' });
  });

  it.each<{ label: string; answers: Record<string, string[]> }>([
    { label: 'missing required', answers: {} },
    { label: 'invalid enum', answers: { choice: ['else'] } },
    { label: 'multiple scalar values', answers: { choice: ['a', 'b'] } },
  ])('cancels invalid form response: $label', async ({ answers }) => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({ properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] })
    );
    bridge.resolvePermission(onEvent.mock.calls[0]![1].requestId, 'accept', answers);
    await expect(response).resolves.toEqual({ action: 'cancel' });
  });

  it.each([
    { schema: { type: 'integer', minimum: 1, maximum: 4 }, value: ['1.5'] },
    { schema: { type: 'number', minimum: 1 }, value: ['0'] },
    { schema: { type: 'number' }, value: ['NaN'] },
    { schema: { type: 'boolean' }, value: ['yes'] },
    { schema: { type: 'string', minLength: 2 }, value: ['a'] },
    {
      schema: { type: 'array', items: { type: 'string', enum: ['a'] }, minItems: 1 },
      value: ['b'],
    },
  ])('validates primitive schema constraints %#', async ({ schema, value }) => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({ properties: { field: schema }, required: ['field'] })
    );
    bridge.resolvePermission(onEvent.mock.calls[0]![1].requestId, 'accept', { field: value });
    await expect(response).resolves.toEqual({ action: 'cancel' });
  });

  it('marks fields optional and accepts a required empty multi-select without a minimum', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: {
          tags: { type: 'array', items: { type: 'string', enum: ['a'] } },
          note: { type: 'string' },
        },
        required: ['tags'],
      })
    );
    const event = onEvent.mock.calls[0]![1];
    expect(event.params.toolCall.rawInput.questions[1]).toMatchObject({
      id: 'note',
      optional: true,
    });
    bridge.resolvePermission(event.requestId, 'accept', { tags: [] });
    await expect(response).resolves.toEqual({ action: 'accept', content: { tags: [] } });
  });

  it('never accepts a form without an explicit allow outcome and answers', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({ properties: { name: { type: 'string' } }, required: ['name'] })
    );
    bridge.resolvePermission(onEvent.mock.calls[0]![1].requestId, 'decline');
    await expect(response).resolves.toEqual({ action: 'decline' });
  });

  it('presents URL target and message and waits for explicit consent', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation({
      mode: 'url',
      sessionId: 'provider-1',
      elicitationId: 'url-1',
      url: 'https://example.com/auth',
      message: 'Connect account',
    });
    const event = onEvent.mock.calls[0]![1];
    expect(bridge.pendingCount).toBe(1);
    expect(onEvent.mock.calls[0]![0]).toBe('db-1');
    expect(event.params.sessionId).toBe('provider-1');
    expect(event.params.toolCall).toMatchObject({
      title: 'Authorize URL',
      rawInput: {
        url: 'https://example.com/auth',
        message: 'Connect account',
        type: 'UrlElicitation',
      },
    });
    bridge.resolvePermission(event.requestId, 'accept');
    await expect(response).resolves.toEqual({ action: 'accept' });
    await expect(handler.completeElicitation({ elicitationId: 'url-1' })).resolves.toBeUndefined();
  });

  it.each(['not a URL', 'javascript:alert(1)', 'file:///tmp/account'])(
    'cancels unsupported URL targets %s',
    async (url) => {
      const { handler, onEvent } = setup();
      await expect(
        handler.createElicitation({
          mode: 'url',
          sessionId: 'provider-1',
          elicitationId: 'url-1',
          url,
          message: 'Authorize',
        })
      ).resolves.toEqual({ action: 'cancel' });
      expect(onEvent).not.toHaveBeenCalled();
    }
  );

  it('preserves field IDs that the composer normally trims', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(
      form({
        properties: { ' name ': { type: 'string', title: 'Your name' } },
        required: [' name '],
      })
    );
    const event = onEvent.mock.calls[0]![1];
    const questionId = event.params.toolCall.rawInput.questions[0].id;
    bridge.resolvePermission(event.requestId, 'accept', { [questionId.trim()]: ['Ada'] });
    await expect(response).resolves.toEqual({ action: 'accept', content: { ' name ': 'Ada' } });
  });

  it('cancels pending forms and URLs on session stop', async () => {
    const { handler, bridge } = setup();
    const responses = [
      handler.createElicitation(form({ properties: { name: { type: 'string' } } })),
      handler.createElicitation({
        mode: 'url',
        sessionId: 'provider-1',
        elicitationId: 'url-1',
        url: 'https://example.com',
        message: 'Authorize',
      }),
    ];
    bridge.cancelAll();
    await expect(Promise.all(responses)).resolves.toEqual([
      { action: 'cancel' },
      { action: 'cancel' },
    ]);
  });

  it('fails closed for unsupported requests and missing bridge', async () => {
    const { handler, onEvent } = setup();
    await expect(
      handler.createElicitation({ mode: '_unknown', sessionId: 'provider-1', message: 'Unknown' })
    ).resolves.toEqual({ action: 'cancel' });
    await expect(
      handler.createElicitation(form({ properties: { nested: { type: 'object' } } }))
    ).resolves.toEqual({ action: 'cancel' });
    await expect(
      new AcpClientHandler('db-1', vi.fn()).createElicitation(form({ properties: {} }))
    ).resolves.toEqual({ action: 'cancel' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('requires explicit consent even for an empty form', async () => {
    const { handler, bridge, onEvent } = setup();
    const response = handler.createElicitation(form({ properties: {} }));
    expect(bridge.pendingCount).toBe(1);
    bridge.resolvePermission(onEvent.mock.calls[0]![1].requestId, 'accept');
    await expect(response).resolves.toEqual({ action: 'accept', content: {} });
  });
});
