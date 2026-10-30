import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from 'vitest';
import { SessionPermissionService } from '@/backend/services/session/service/lifecycle/session.permission.service';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { isExitPlanModeRequest } from '@/shared/pending-request-types';
import { AcpClientHandler } from './acp-client-handler';
import { AcpPermissionBridge } from './acp-permission-bridge';

// claude-agent-acp 0.99.1 buildClaudePermissionPresentation for an AIR client.
// The permission request deliberately omits the tool call's name and kind.
function claudePlanRequest(): RequestPermissionRequest {
  return {
    sessionId: 'provider-session',
    toolCall: {
      toolCallId: 'exit-plan-1',
      title: 'Approve Plan',
      rawInput: { plan: '# Implementation plan\n\n1. Update the service.\n2. Run its tests.' },
    },
    _meta: { jetbrains: { air: { permission: { version: 1, title: 'Ready to code?' } } } },
    options: [
      { optionId: 'exit-plan-auto', kind: 'allow_always', name: 'Yes, and use auto mode' },
      { optionId: 'exit-plan-default', kind: 'allow_once', name: 'Yes, manually approve edits' },
      { optionId: 'reject', kind: 'reject_once', name: 'No, keep planning' },
    ],
  };
}

describe('Claude AIR plan permission contract', () => {
  it.each(['exit-plan-auto', 'exit-plan-default', 'reject'])(
    'presents and restores the full plan while preserving the %s choice',
    async (optionId) => {
      const domain = new SessionDomainService();
      const service = new SessionPermissionService({ sessionDomainService: domain });
      const bridge = service.createPermissionBridge('session-1');
      const handler = new AcpClientHandler(
        'session-1',
        (sessionId, event) => {
          if (event.type === 'acp_permission_request') {
            service.handlePermissionRequest(sessionId, event);
          }
        },
        bridge
      );
      const request = claudePlanRequest();
      const response = handler.requestPermission(request);
      const pending = domain.getPendingInteractiveRequest('session-1');
      expect(pending).toMatchObject({
        toolName: 'ExitPlanMode',
        toolUseId: 'exit-plan-1',
        planContent: '# Implementation plan\n\n1. Update the service.\n2. Run its tests.',
        input: {
          type: 'ExitPlanMode',
          providerContinuesAfterApproval: true,
        },
        acpOptions: request.options,
      });
      expect(isExitPlanModeRequest(pending!)).toBe(true);
      expect(service.respondToPermission('session-1', pending!.requestId, optionId)).toBe(true);
      await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId } });
      expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    }
  );

  it('retains the read-only reviewer rejection for Claude AIR plan requests', async () => {
    const service = new SessionPermissionService({
      sessionDomainService: new SessionDomainService(),
    });
    const bridge = service.createPermissionBridge('review', ADVERSARIAL_REVIEW_WORKFLOW);
    const handler = new AcpClientHandler(
      'review',
      () => {
        throw new Error('Read-only plan requests must not expose an approval');
      },
      bridge
    );
    await expect(handler.requestPermission(claudePlanRequest())).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it.each([
    { title: 'Approve Plan', rawInput: {} },
    { title: 'Approve Plan', rawInput: { plan: 42 } },
    { title: 'Write plan', rawInput: { plan: '# A file to write' } },
  ])('keeps ordinary permission $title with $rawInput unchanged', async (toolCall) => {
    const request: RequestPermissionRequest = {
      ...claudePlanRequest(),
      toolCall: { toolCallId: 'ordinary-tool', ...toolCall },
    };
    const bridge = new AcpPermissionBridge();
    let requestId = '';
    const handler = new AcpClientHandler(
      'session-1',
      (_, event) => {
        if (event.type === 'acp_permission_request') {
          requestId = event.requestId;
          expect(event.params).toEqual(request);
        }
      },
      bridge
    );
    const response = handler.requestPermission(request);
    expect(bridge.resolvePermission(requestId, 'reject')).toBe(true);
    await response;
  });
});
