import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudePermissionCoordinator } from './permission-coordinator';
import { AutoApproveHandler } from './permissions';
import type { ControlResponseBody } from './protocol';
import type { ProtocolIO } from './protocol-io';
import type {
  ClaudeContentItem,
  ControlCancelRequest,
  ControlRequest,
  InitializeResponseData,
  PermissionMode,
  RewindFilesResponse,
} from './types';

class FakeProtocol extends EventEmitter implements ProtocolIO {
  sendControlResponse = vi.fn(
    async (_requestId: string, _response: ControlResponseBody) => undefined
  );
  sendInitialize = vi.fn(async () => ({}) as InitializeResponseData);
  sendSetPermissionMode = vi.fn(async (_mode: PermissionMode) => undefined);
  sendUserMessage = vi.fn(async (_content: string | ClaudeContentItem[]) => undefined);
  sendSetModel = vi.fn(async (_model?: string) => undefined);
  sendSetMaxThinkingTokens = vi.fn(async (_tokens: number | null) => undefined);
  sendInterrupt = vi.fn(async () => undefined);
  sendRewindFiles = vi.fn(async () => ({}) as RewindFilesResponse);

  start(): void {
    // no-op
  }

  stop(): void {
    // no-op
  }
}

const askUserQuestionInput = {
  questions: [
    {
      question: 'Ready to proceed?',
      header: 'Confirm',
      options: [
        { label: 'Yes', description: 'Continue' },
        { label: 'No', description: 'Cancel' },
      ],
    },
  ],
};

const buildAskUserQuestionRequest = (requestId: string, toolUseId: string): ControlRequest => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    input: askUserQuestionInput,
  },
});

describe('ClaudePermissionCoordinator', () => {
  it('emits interactive_request and sends answers via protocol', async () => {
    const protocol = new FakeProtocol();
    const coordinator = new ClaudePermissionCoordinator({
      permissionHandler: new AutoApproveHandler(),
    });

    coordinator.bind(protocol);

    const interactivePromise = new Promise<{ requestId: string }>((resolve) => {
      coordinator.on('interactive_request', (request) => resolve(request));
    });

    protocol.emit('control_request', buildAskUserQuestionRequest('req-1', 'tool-1'));

    const interactive = await interactivePromise;
    coordinator.answerQuestion(interactive.requestId, { 'Ready to proceed?': 'Yes' });

    await vi.waitFor(() => expect(protocol.sendControlResponse).toHaveBeenCalled());

    const [requestId, response] = protocol.sendControlResponse.mock.calls[0];
    expect(requestId).toBe('req-1');
    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: askUserQuestionInput.questions,
        answers: { 'Ready to proceed?': 'Yes' },
      },
    });
  });

  it('emits permission_cancelled without sending a deny response', async () => {
    const protocol = new FakeProtocol();
    const coordinator = new ClaudePermissionCoordinator({
      permissionHandler: new AutoApproveHandler(),
    });

    coordinator.bind(protocol);

    const cancelledPromise = new Promise<string>((resolve) => {
      coordinator.on('permission_cancelled', (requestId) => resolve(requestId));
    });

    protocol.emit('control_request', buildAskUserQuestionRequest('req-2', 'tool-2'));

    const cancel: ControlCancelRequest = {
      type: 'control_cancel_request',
      request_id: 'req-2',
    };

    protocol.emit('control_cancel', cancel);

    const cancelledId = await cancelledPromise;
    expect(cancelledId).toBe('tool-2');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(protocol.sendControlResponse).not.toHaveBeenCalled();
  });
});
