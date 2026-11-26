import { describe, expect, it, vi } from 'vitest';
import { AcpClientHandler } from '@/backend/services/session/service/acp/acp-client-handler';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionPermissionService } from './session.permission.service';

describe('SessionPermissionService', () => {
  const sessionDomain = {
    emitDelta: vi.fn(),
    allocateOrder: vi.fn(),
    upsertQuestionResponse: vi.fn(),
    setPendingInteractiveRequest: vi.fn(),
    clearPendingInteractiveRequestIfMatches: vi.fn(),
  };

  function createService(): SessionPermissionService {
    vi.clearAllMocks();
    return new SessionPermissionService({
      sessionDomainService: unsafeCoerce(sessionDomain),
    });
  }

  it.each(['ExitPlanMode', 'Bash', 'Edit'])(
    'denies review %s permission requests without exposing an approval',
    async (tool) => {
      const service = createService();
      const bridge = service.createPermissionBridge('review', ADVERSARIAL_REVIEW_WORKFLOW);
      const params = unsafeCoerce<Parameters<typeof bridge.waitForUserResponse>[1]>({
        toolCall: { toolCallId: 'tool-1', title: tool, rawInput: { type: tool, questions: [] } },
        options: [
          { optionId: 'acceptEdits', name: 'Approve', kind: 'allow_once' },
          { optionId: 'plan', name: 'Keep planning', kind: 'reject_once' },
        ],
      });
      service.handlePermissionRequest('review', {
        type: 'acp_permission_request',
        requestId: 'req',
        params,
      });
      await expect(bridge.waitForUserResponse('req', params)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'plan' },
      });
      expect(service.respondToPermission('review', 'req', 'acceptEdits')).toBe(false);
      expect(sessionDomain.setPendingInteractiveRequest).not.toHaveBeenCalled();
    }
  );

  it('denies review permissions on subsequent turns', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('review', ADVERSARIAL_REVIEW_WORKFLOW);
    const onEvent = vi.fn();
    const handler = new AcpClientHandler('review', onEvent, bridge);
    for (const tool of ['ExitPlanMode', 'Edit']) {
      const response = await handler.requestPermission(
        unsafeCoerce({
          sessionId: 'review',
          toolCall: { toolCallId: tool, title: tool },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_always' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        })
      );
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    }
    expect(onEvent).not.toHaveBeenCalled();
    expect(bridge.pendingCount).toBe(0);
  });

  it('cancels a review permission without a rejection option', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('review', ADVERSARIAL_REVIEW_WORKFLOW);
    await expect(
      bridge.waitForUserResponse(
        'req',
        unsafeCoerce({
          toolCall: { title: 'ExitPlanMode' },
          options: [{ optionId: 'allow', kind: 'allow_once' }],
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it.each(['AskUserQuestion', 'item/tool/requestUserInput'])(
    'denies %s requests in unattended reviews',
    async (tool) => {
      const service = createService();
      const bridge = service.createPermissionBridge('review', ADVERSARIAL_REVIEW_WORKFLOW);
      const response = bridge.waitForUserResponse(
        'question',
        unsafeCoerce({
          toolCall: { title: tool, rawInput: { questions: [] } },
          options: [{ optionId: 'answer', kind: 'allow_once' }],
        })
      );
      expect(service.respondToPermission('review', 'question', 'answer')).toBe(false);
      await expect(response).resolves.toEqual({
        outcome: { outcome: 'cancelled' },
      });
    }
  );

  it('dismisses cancelled permission prompts while retaining the live bridge', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');
    const params = unsafeCoerce<Parameters<typeof bridge.waitForUserResponse>[1]>({
      toolCall: { toolCallId: 'tool-1', title: 'Command' },
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
    });
    const response = bridge.waitForUserResponse('req-1', params);
    bridge.cancelAll();
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(sessionDomain.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'permission_cancelled',
      requestId: 'req-1',
    });
    expect(sessionDomain.clearPendingInteractiveRequestIfMatches).toHaveBeenCalledWith(
      'session-1',
      'req-1'
    );
    expect(service.createPermissionBridge('session-1')).toBe(bridge);
    const next = bridge.waitForUserResponse('req-2', params);
    expect(service.respondToPermission('session-1', 'req-2', 'allow_once')).toBe(true);
    await expect(next).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
  });

  it('resolves pending ACP permissions through the session bridge', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');

    const responsePromise = bridge.waitForUserResponse(
      'req-1',
      unsafeCoerce({
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Command',
          rawInput: { command: 'pwd' },
        },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      })
    );

    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(true);
    await expect(responsePromise).resolves.toMatchObject({
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
  });

  it('replaces the original tool row with the accepted answers and hides secret fields', async () => {
    const domain = new SessionDomainService();
    const service = new SessionPermissionService({ sessionDomainService: domain });
    const handler = new AcpClientHandler(
      'session-1',
      (sessionId, event) => {
        if (event.type === 'acp_permission_request') {
          service.handlePermissionRequest(sessionId, event);
        }
      },
      service.createPermissionBridge('session-1')
    );
    const rawInput = {
      questions: [
        {
          id: 'processes',
          header: 'Why view',
          question: 'Which processes?',
          options: [{ value: 'whole', label: 'Whole machine', description: '' }],
          multiSelect: true,
        },
        {
          id: 'note',
          question: 'Any notes?',
          optional: true,
          companionNote: { questionId: 'processes', revealOnValue: 'None of the above' },
        },
        { id: 'secret', question: 'Token?', isSecret: true, _meta: { codex: 'unexpected' } },
      ],
    };
    const tool = domain.appendClaudeEvent('session-1', {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: rawInput },
      },
    });
    domain.appendClaudeEvent('session-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Interleaving message' }] },
    });
    const response = handler.requestPermission({
      sessionId: 'native',
      toolCall: { toolCallId: 'tool-1', title: 'AskUserQuestion', rawInput },
      options: [{ optionId: 'accept', name: 'Answer', kind: 'allow_once' }],
    });
    const requestId = domain.getPendingInteractiveRequest('session-1')!.requestId;
    const answers = {
      processes: ['whole', 'Only active'],
      note: ['Include inactive workspaces too'],
      secret: ['private-token'],
    };
    expect(service.respondToPermission('session-1', requestId, 'missing', answers)).toBe(false);
    expect(service.respondToPermission('session-1', requestId, 'accept', answers)).toBe(true);
    expect(service.respondToPermission('session-1', requestId, 'accept', answers)).toBe(false);
    await expect(response).resolves.toMatchObject({
      outcome: { outcome: 'selected', optionId: 'accept' },
    });

    const late = domain.appendClaudeEvent('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Echoes the private-token value',
          },
        ],
      },
    });
    expect(late.messageId).toBe(tool.messageId);
    expect(late.replacement?.type).toBe('question_response');
    const rows = domain.getTranscriptSnapshot('session-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: tool.messageId,
      order: tool.order,
      message: {
        type: 'question_response',
        questionResponse: {
          toolUseId: 'tool-1',
          status: 'answered',
          questions: [
            {
              question: 'Which processes?',
              answers: ['Whole machine', 'Only active'],
              note: 'Include inactive workspaces too',
            },
            { question: 'Token?', answers: [], redacted: true },
          ],
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain('private-token');
  });

  it('shows an async Codex answer after work streamed while its question was open', async () => {
    const domain = new SessionDomainService();
    const persist = vi.fn().mockResolvedValue(undefined);
    const service = new SessionPermissionService({
      sessionDomainService: domain,
      getProviderSessionId: () => 'native',
      persistQuestionResponse: persist,
    });
    const handler = new AcpClientHandler(
      'session-1',
      (sessionId, event) => {
        if (event.type === 'acp_permission_request') {
          service.handlePermissionRequest(sessionId, event);
        }
      },
      service.createPermissionBridge('session-1')
    );
    const response = handler.createElicitation({
      mode: 'form',
      sessionId: 'native',
      message: 'Codex keeps working while you answer.',
      requestedSchema: {
        properties: {
          question_0: {
            type: 'string',
            title: 'Should I use the preview?',
            _meta: { codex: { isOther: true } },
            oneOf: [
              { const: 'Yes', title: 'Yes' },
              { const: 'No', title: 'No' },
            ],
          },
          question_0_note: {
            type: 'string',
            title: 'Additional answer or note',
            _meta: { codex: { role: 'user_note', questionId: 'question_0' } },
          },
        },
      },
      _meta: { codex: { delivery: 'async' } },
    });
    domain.appendClaudeEvent('session-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Work in progress' }] },
    });
    const requestId = domain.getPendingInteractiveRequest('session-1')!.requestId;
    const emit = vi.spyOn(domain, 'upsertQuestionResponse');
    await service.respondToPermission('session-1', requestId, 'accept', {
      question_0: ['Yes'],
      question_0_note: ['Keep the notes'],
    });
    await expect(response).resolves.toEqual({
      action: 'accept',
      content: { question_0: 'Yes', question_0_note: 'Keep the notes' },
    });
    expect(domain.getTranscriptSnapshot('session-1')).toMatchObject([
      { message: { type: 'assistant' } },
      {
        message: {
          type: 'question_response',
          questionResponse: {
            status: 'answered',
            questions: [
              { question: 'Should I use the preview?', answers: ['Yes\n\nKeep the notes'] },
            ],
          },
        },
      },
    ]);
    expect(emit).toHaveBeenCalledOnce();
    const answer = domain.getTranscriptSnapshot('session-1')[1]?.message;
    expect(answer?.type === 'question_response' && answer.questionResponse.questions).toEqual([
      { question: 'Should I use the preview?', answers: ['Yes\n\nKeep the notes'] },
    ]);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    { optionId: 'accept', answers: { count: ['0'] }, action: 'cancel' },
    { optionId: 'decline', answers: { count: ['1'] }, action: 'decline' },
  ])(
    'records the $action ACP form action as a cancelled transcript response',
    async ({ optionId, answers, action }) => {
      const domain = new SessionDomainService();
      const service = new SessionPermissionService({ sessionDomainService: domain });
      const handler = new AcpClientHandler(
        'session-1',
        (sessionId, event) => {
          if (event.type === 'acp_permission_request') {
            service.handlePermissionRequest(sessionId, event);
          }
        },
        service.createPermissionBridge('session-1')
      );
      const response = handler.createElicitation({
        mode: 'form',
        sessionId: 'native',
        message: 'Pick a count',
        requestedSchema: {
          properties: { count: { type: 'integer', minimum: 1 } },
          required: ['count'],
        },
      });
      const requestId = domain.getPendingInteractiveRequest('session-1')!.requestId;
      expect(service.respondToPermission('session-1', requestId, optionId, answers)).toBe(true);
      await expect(response).resolves.toEqual({ action });
      expect(domain.getTranscriptSnapshot('session-1')).toMatchObject([
        {
          message: {
            type: 'question_response',
            questionToolDetails: {
              toolName: 'AskUserQuestion',
              input: { questions: [{ validation: { type: 'integer', minimum: 1 } }] },
            },
            questionResponse: {
              status: 'cancelled',
              questions: [{ question: 'count', answers: [] }],
            },
          },
        },
      ]);
    }
  );

  it('records cancellation for each overlapping question without republishing one', async () => {
    const domain = new SessionDomainService();
    const service = new SessionPermissionService({ sessionDomainService: domain });
    const shown = vi.spyOn(domain, 'emitDelta');
    const handler = new AcpClientHandler(
      'session',
      (sessionId, event) => {
        if (event.type === 'acp_permission_request') {
          service.handlePermissionRequest(sessionId, event);
        }
      },
      service.createPermissionBridge('session')
    );
    const ask = (id: string) =>
      handler.requestPermission({
        sessionId: 'native',
        toolCall: {
          toolCallId: id,
          title: 'AskUserQuestion',
          rawInput: { questions: [{ question: id }] },
        },
        options: [{ optionId: 'allow', name: 'Answer', kind: 'allow_once' }],
      });
    const pending = [ask('First'), ask('Second')];
    service.cancelPendingRequests('session');
    expect(await Promise.all(pending)).toEqual([
      { outcome: { outcome: 'cancelled' } },
      { outcome: { outcome: 'cancelled' } },
    ]);
    expect(shown.mock.calls.filter(([, delta]) => delta.type === 'user_question')).toHaveLength(2);
    expect(domain.getTranscriptSnapshot('session').map((row) => row.message)).toMatchObject([
      { questionResponse: { status: 'cancelled', toolUseId: 'First' } },
      { questionResponse: { status: 'cancelled', toolUseId: 'Second' } },
    ]);
  });

  it('cancels only the aborted ACP request and rejects its stale answer', async () => {
    const domain = new SessionDomainService();
    const service = new SessionPermissionService({ sessionDomainService: domain });
    const handler = new AcpClientHandler(
      'session',
      (sessionId, event) => {
        if (event.type === 'acp_permission_request') {
          service.handlePermissionRequest(sessionId, event);
        }
      },
      service.createPermissionBridge('session')
    );
    const request = (title: string) => ({
      mode: 'form' as const,
      sessionId: 'native',
      message: title,
      requestedSchema: { properties: { choice: { type: 'string' as const } } },
    });
    const prior = handler.createElicitation(request('Prior question'));
    const priorId = domain.getPendingInteractiveRequest('session')!.requestId;
    const aborter = new AbortController();
    const cancelled = handler.createElicitation(request('Aborted question'), aborter.signal);
    const cancelledId = domain.getPendingInteractiveRequest('session')!.requestId;

    aborter.abort();
    expect(
      service.respondToPermission('session', cancelledId, 'accept', { choice: ['stale'] })
    ).toBe(false);
    expect(domain.getPendingInteractiveRequest('session')?.requestId).toBe(priorId);
    expect(
      service.respondToPermission('session', priorId, 'accept', { choice: ['accepted'] })
    ).toBe(true);
    await expect(cancelled).resolves.toEqual({ action: 'cancel' });
    await expect(prior).resolves.toEqual({ action: 'accept', content: { choice: 'accepted' } });
    expect(domain.getTranscriptSnapshot('session').map((row) => row.message)).toMatchObject([
      { questionResponse: { status: 'answered', requestId: priorId } },
      { questionResponse: { status: 'cancelled', requestId: cancelledId } },
    ]);
  });

  it('reuses the existing ACP permission bridge for repeated session setup', () => {
    const service = createService();

    const firstBridge = service.createPermissionBridge('session-1');
    const secondBridge = service.createPermissionBridge('session-1');

    expect(secondBridge).toBe(firstBridge);
  });

  it('keeps pending ACP permissions reachable when bridge creation is repeated', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');

    const responsePromise = bridge.waitForUserResponse(
      'req-1',
      unsafeCoerce({
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Command',
          rawInput: { command: 'pwd' },
        },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      })
    );

    service.createPermissionBridge('session-1');

    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(true);
    expect(bridge.hasPending('req-1')).toBe(false);
    await expect(responsePromise).resolves.toMatchObject({
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
  });

  it('creates a fresh ACP permission bridge after session cancellation clears one', () => {
    const service = createService();
    const firstBridge = service.createPermissionBridge('session-1');

    service.cancelPendingRequests('session-1');

    const secondBridge = service.createPermissionBridge('session-1');
    expect(secondBridge).not.toBe(firstBridge);
  });

  it('cancels pending permissions and clears the bridge for the session', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');

    const responsePromise = bridge.waitForUserResponse(
      'req-1',
      unsafeCoerce({
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Command',
          rawInput: { command: 'pwd' },
        },
        options: [],
      })
    );

    service.cancelPendingRequests('session-1');

    await expect(responsePromise).resolves.toMatchObject({
      outcome: {
        outcome: 'cancelled',
      },
    });
    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(false);
  });

  it('emits permission_request delta for non-question ACP permission events', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-1',
        params: {
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Run shell command',
            rawInput: {
              command: 'pwd',
            },
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'permission_request',
        requestId: 'req-1',
        toolName: 'Run shell command',
        toolUseId: 'tool-1',
      })
    );
    expect(sessionDomain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        requestId: 'req-1',
        toolName: 'Run shell command',
        toolUseId: 'tool-1',
      })
    );
  });

  it('emits user_question delta when permission payload includes questions', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-2',
        params: {
          toolCall: {
            toolCallId: 'tool-2',
            title: 'AskUserQuestion',
            rawInput: {
              questions: [
                {
                  id: 'q1',
                  question: 'Which path?',
                  header: 'Path',
                  options: [{ label: 'A', description: 'Use A' }],
                },
              ],
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'user_question',
        requestId: 'req-2',
        toolName: 'AskUserQuestion',
      })
    );
  });

  it('normalizes free-form user question options before emitting and storing', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-questions-freeform',
        params: {
          toolCall: {
            toolCallId: 'tool-questions-freeform',
            title: 'AskUserQuestion',
            rawInput: {
              questions: [
                {
                  id: 'q1',
                  question: 'What should happen next?',
                  header: 'Next',
                  options: null,
                },
              ],
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    const expectedQuestions = [
      {
        id: 'q1',
        question: 'What should happen next?',
        header: 'Next',
        options: [],
      },
    ];

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'user_question',
        questions: expectedQuestions,
      })
    );
    expect(sessionDomain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        input: expect.objectContaining({
          questions: expectedQuestions,
        }),
      })
    );
  });

  it('extracts plan content for ExitPlanMode permission payloads', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-3',
        params: {
          toolCall: {
            toolCallId: 'tool-3',
            title: 'ExitPlanMode',
            rawInput: {
              plan: {
                markdown: '# Plan\n- Step 1',
              },
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'permission_request',
        planContent: '# Plan\n- Step 1',
      })
    );
  });

  it('uses stable ExitPlanMode input type when permission title is only a display label', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-plan-display-title',
        params: {
          toolCall: {
            toolCallId: 'tool-plan-display-title',
            title: 'Review Proposed Plan',
            rawInput: {
              type: 'ExitPlanMode',
              plan: '# My Plan',
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'permission_request',
        toolName: 'ExitPlanMode',
        planContent: '# My Plan',
      })
    );
    expect(sessionDomain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        toolName: 'ExitPlanMode',
        planContent: '# My Plan',
      })
    );
  });
});

describe('permission response pending state', () => {
  function setup() {
    const domain = new SessionDomainService();
    const service = new SessionPermissionService({ sessionDomainService: domain });
    const bridge = service.createPermissionBridge('session-1');
    const params = {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Command' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once' as const, name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once' as const, name: 'Reject once' },
      ],
    };
    function request(requestId: string) {
      const response = bridge.waitForUserResponse(requestId, params);
      service.handlePermissionRequest('session-1', {
        type: 'acp_permission_request',
        requestId,
        params,
      });
      return response;
    }
    return { domain, service, bridge, request };
  }

  it.each(['allow_once', 'reject_once'])(
    'clears the matching pending request after a direct %s response',
    async (optionId) => {
      const { domain, service, request } = setup();
      const response = request('req-1');
      expect(service.respondToPermission('session-1', 'req-1', optionId)).toBe(true);
      expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
      await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId } });
    }
  );

  it.each(['unknown-request', 'invalid-option'])(
    'preserves the pending request when resolution fails for %s',
    async (failure) => {
      const { domain, service, bridge, request } = setup();
      const response = request('req-1');
      const pending = domain.getPendingInteractiveRequest('session-1');
      expect(
        service.respondToPermission(
          'session-1',
          failure === 'unknown-request' ? 'stale-request' : 'req-1',
          failure === 'invalid-option' ? 'invalid' : 'allow_once'
        )
      ).toBe(false);
      expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
      expect(bridge.hasPending('req-1')).toBe(true);
      service.cancelPendingRequests('session-1');
      await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    }
  );

  it('preserves a replacement request after successful and duplicate older responses', async () => {
    const { domain, service, request } = setup();
    const older = request('req-1');
    const replacement = request('req-2');
    const pending = domain.getPendingInteractiveRequest('session-1');
    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(false);
    expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
    expect(service.respondToPermission('session-1', 'req-2', 'allow_once')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    await expect(older).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
    await expect(replacement).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
  });

  it('restores an older concurrent request after the newer one is answered', async () => {
    const { domain, service, bridge, request } = setup();
    const emitDelta = vi.spyOn(domain, 'emitDelta');
    const older = request('req-1');
    const newer = request('req-2');
    expect(domain.getPendingInteractiveRequest('session-1')?.requestId).toBe('req-2');
    emitDelta.mockClear();

    expect(service.respondToPermission('session-1', 'req-2', 'allow_once')).toBe(true);

    expect(bridge.hasPending('req-1')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')?.requestId).toBe('req-1');
    expect(emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'permission_request', requestId: 'req-1' })
    );
    await expect(newer).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
    expect(service.respondToPermission('session-1', 'req-1', 'reject_once')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    await expect(older).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    });
  });

  it('shows the newest request still awaiting a response after the shown one is answered', async () => {
    const { domain, service, request } = setup();
    const responses = [request('req-1'), request('req-2'), request('req-3')];
    expect(service.respondToPermission('session-1', 'req-3', 'allow_once')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')?.requestId).toBe('req-2');
    expect(service.respondToPermission('session-1', 'req-2', 'allow_once')).toBe(true);
    expect(domain.getPendingInteractiveRequest('session-1')?.requestId).toBe('req-1');
    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(true);
    await expect(Promise.all(responses)).resolves.toHaveLength(3);
  });

  it('does not restore concurrent requests cancelled together', async () => {
    const { domain, bridge, request } = setup();
    const emitDelta = vi.spyOn(domain, 'emitDelta');
    const responses = [request('req-1'), request('req-2')];
    emitDelta.mockClear();

    bridge.cancelAll();

    await expect(Promise.all(responses)).resolves.toEqual([
      { outcome: { outcome: 'cancelled' } },
      { outcome: { outcome: 'cancelled' } },
    ]);
    expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    expect(emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'permission_request' })
    );
  });
});
