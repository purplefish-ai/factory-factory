import { describe, expect, it, vi } from 'vitest';
import { AcpClientHandler } from '@/backend/services/session/service/acp/acp-client-handler';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionPermissionService } from './session.permission.service';

const usableQuestions = [{ question: 'Pick a path', options: [{ label: 'A' }] }];

function createHarness(workflow?: string) {
  const domain = {
    emitDelta: vi.fn(),
    setPendingInteractiveRequest: vi.fn(),
    clearPendingInteractiveRequestIfMatches: vi.fn(),
  };
  const service = new SessionPermissionService({ sessionDomainService: unsafeCoerce(domain) });
  const bridge = service.createPermissionBridge('session', workflow);
  const handler = new AcpClientHandler(
    'session',
    (_id, event) => {
      if (event.type === 'acp_permission_request') {
        service.handlePermissionRequest('session', event);
      }
    },
    bridge
  );
  return { domain, service, bridge, handler };
}

function request(title: string, questions: unknown, name?: string) {
  return unsafeCoerce<Parameters<AcpClientHandler['requestPermission']>[0]>({
    sessionId: 'session',
    toolCall: { toolCallId: 'tool', title, ...(name ? { name } : {}), rawInput: { questions } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
}

describe('permission question classification', () => {
  it.each(
    [[], ['survey question'], [{ prompt: 'Survey prompt' }], usableQuestions].map((questions) => [
      questions,
    ])
  )(
    'keeps MCP questions %j resolvable through normal approval despite question-like display title',
    async (questions) => {
      const harness = createHarness();
      const response = harness.handler.requestPermission(
        request('AskUserQuestion', questions, 'mcp__survey__poll')
      );
      expect(harness.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          type: 'permission_request',
          toolInput: { questions },
        })
      );
      expect(harness.domain.emitDelta).not.toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ type: 'user_question' })
      );
      expect(harness.domain.setPendingInteractiveRequest).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ rawToolName: 'mcp__survey__poll' })
      );
      const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
      expect(harness.service.respondToPermission('session', requestId, 'allow')).toBe(true);
      await expect(response).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(harness.bridge.pendingCount).toBe(0);
    }
  );

  it('routes an optional elicitation field through the question UI and back to ACP', async () => {
    const harness = createHarness();
    const response = harness.handler.createElicitation({
      mode: 'form',
      sessionId: 'session',
      message: 'Add a note if needed',
      requestedSchema: { properties: { note: { type: 'string', title: 'Additional note' } } },
    });
    expect(harness.domain.emitDelta).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'user_question',
        questions: [expect.objectContaining({ id: 'note', optional: true })],
      })
    );
    const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
    expect(harness.service.respondToPermission('session', requestId, 'accept', {})).toBe(true);
    await expect(response).resolves.toEqual({ action: 'accept', content: {} });
  });

  it.each([true, false])(
    'preserves native custom-choice permission isOther=%s in the question UI',
    async (isOther) => {
      const harness = createHarness();
      const response = harness.handler.createElicitation({
        mode: 'form',
        sessionId: 'session',
        message: 'Choose',
        requestedSchema: {
          properties: { choice: { type: 'string', enum: ['A'], _meta: { codex: { isOther } } } },
          required: ['choice'],
        },
      });
      expect(harness.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          type: 'user_question',
          questions: [expect.objectContaining({ id: 'choice', allowOther: isOther })],
        })
      );
      const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
      expect(
        harness.service.respondToPermission('session', requestId, 'accept', {
          choice: ['My own answer'],
        })
      ).toBe(true);
      await expect(response).resolves.toEqual(
        isOther ? { action: 'accept', content: { choice: 'My own answer' } } : { action: 'cancel' }
      );
    }
  );

  it('presents an empty elicitation form as explicit consent rather than an empty question', async () => {
    const harness = createHarness();
    const response = harness.handler.createElicitation({
      mode: 'form',
      sessionId: 'session',
      message: 'Confirm this request',
      requestedSchema: { properties: {} },
    });
    expect(harness.domain.emitDelta).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'permission_request',
        toolName: 'Confirm request',
        elicitation: 'form',
        toolInput: { type: 'FormElicitation', message: 'Confirm this request' },
      })
    );
    expect(harness.domain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ elicitation: 'form' })
    );
    expect(harness.domain.emitDelta).not.toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ type: 'user_question' })
    );
    const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
    expect(harness.service.respondToPermission('session', requestId, 'accept')).toBe(true);
    await expect(response).resolves.toEqual({ action: 'accept', content: {} });
  });

  it.each(['form', 'url'] as const)(
    'denies reviewer %s elicitation without prompting',
    async (mode) => {
      const harness = createHarness(ADVERSARIAL_REVIEW_WORKFLOW);
      const request =
        mode === 'form'
          ? {
              mode,
              sessionId: 'session',
              message: 'Choose',
              requestedSchema: {
                properties: { choice: { type: 'string' as const } },
                required: ['choice'],
              },
            }
          : {
              mode,
              sessionId: 'session',
              message: 'Authorize',
              url: 'https://example.com',
              elicitationId: 'url-1',
            };
      await expect(harness.handler.createElicitation(request)).resolves.toEqual({
        action: 'decline',
      });
      expect(harness.domain.emitDelta).not.toHaveBeenCalled();
      expect(harness.bridge.pendingCount).toBe(0);
    }
  );

  it('preserves a nameless MCP title when input type claims to be a provider question', async () => {
    const harness = createHarness();
    const params = request('mcp__survey__poll', usableQuestions);
    params.toolCall.rawInput = { type: 'AskUserQuestion', questions: usableQuestions };
    const response = harness.handler.requestPermission(params);
    expect(harness.domain.emitDelta).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ type: 'permission_request' })
    );
    expect(harness.domain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ toolName: 'mcp__survey__poll', rawToolName: 'mcp__survey__poll' })
    );
    const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
    expect(harness.service.respondToPermission('session', requestId, 'allow')).toBe(true);
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  });

  it.each(['AskUserQuestion', 'item/tool/requestUserInput', 'Tool input request'])(
    'keeps valid %s question requests interactive',
    async (title) => {
      const harness = createHarness();
      const response = harness.handler.requestPermission(request(title, usableQuestions));
      expect(harness.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          type: 'user_question',
          questions: [{ question: 'Pick a path', options: [{ label: 'A', description: '' }] }],
        })
      );
      const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
      expect(
        harness.service.respondToPermission('session', requestId, 'allow', { 'Pick a path': ['A'] })
      ).toBe(true);
      await expect(response).resolves.toMatchObject({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    }
  );

  it.each([
    ['Survey', ['question text'], undefined],
    ['AskUserQuestion', [], undefined],
    ['AskUserQuestion', [{ question: 12 }], undefined],
    ['AskUserQuestion', [{ question: 'Pick', options: [{ value: 'A' }] }], undefined],
    ['AskUserQuestion', usableQuestions, 'mcp__survey__poll'],
  ])(
    'requires explicit tool approval for non-question input %s %j',
    async (title, questions, name) => {
      const harness = createHarness();
      const response = harness.handler.requestPermission(
        request(title as string, questions, name as string | undefined)
      );
      expect(harness.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ type: 'permission_request' })
      );
      const requestId = harness.domain.setPendingInteractiveRequest.mock.calls[0]?.[1].requestId;
      expect(harness.service.respondToPermission('session', requestId, 'allow')).toBe(true);
      await expect(response).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(harness.bridge.pendingCount).toBe(0);
    }
  );

  it('preserves adversarial-review denial before question classification', async () => {
    const harness = createHarness(ADVERSARIAL_REVIEW_WORKFLOW);
    await expect(
      harness.handler.requestPermission(
        request('AskUserQuestion', usableQuestions, 'mcp__survey__poll')
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    expect(harness.domain.emitDelta).not.toHaveBeenCalled();
    expect(harness.bridge.pendingCount).toBe(0);
  });
});
