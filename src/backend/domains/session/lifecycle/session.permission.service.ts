import { AcpPermissionBridge, type AcpPermissionRequestEvent } from '@/backend/domains/session/acp';
import type { SessionDomainService } from '@/backend/domains/session/session-domain.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { AskUserQuestion } from '@/shared/acp-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { isUserQuestionRequest } from '@/shared/pending-request-types';

export type SessionPermissionServiceDependencies = {
  sessionDomainService?: SessionDomainService;
};

export class SessionPermissionService {
  private readonly sessionDomainService: SessionDomainService;
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();

  constructor(options?: SessionPermissionServiceDependencies) {
    this.sessionDomainService = options?.sessionDomainService ?? sessionDomainService;
  }

  createPermissionBridge(sessionId: string): AcpPermissionBridge {
    const bridge = new AcpPermissionBridge();
    this.acpPermissionBridges.set(sessionId, bridge);
    return bridge;
  }

  cancelPendingRequests(sessionId: string): void {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return;
    }

    bridge.cancelAll();
    this.acpPermissionBridges.delete(sessionId);
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string[]>
  ): boolean {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return false;
    }

    return bridge.resolvePermission(requestId, optionId, answers);
  }

  handlePermissionRequest(sessionId: string, event: AcpPermissionRequestEvent): void {
    const { requestId, params } = event;
    const toolName = params.toolCall.title ?? 'ACP Tool';
    const toolInput = (params.toolCall.rawInput as Record<string, unknown>) ?? {};
    const acpOptions = params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const planContent = this.extractPlanContent(toolName, toolInput);

    if (isUserQuestionRequest({ toolName, input: toolInput })) {
      const questions = this.extractAskUserQuestions(toolInput);
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'user_question',
        requestId,
        toolName,
        questions,
        acpOptions,
      });
    } else {
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'permission_request',
        requestId,
        toolName,
        toolUseId: params.toolCall.toolCallId,
        toolInput,
        planContent,
        acpOptions,
      });
    }

    this.sessionDomainService.setPendingInteractiveRequest(sessionId, {
      requestId,
      toolName,
      toolUseId: params.toolCall.toolCallId,
      input: toolInput,
      planContent,
      acpOptions,
      timestamp: new Date().toISOString(),
    });
  }

  private extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const questions = input.questions;
    if (!Array.isArray(questions)) {
      return [];
    }

    return questions as AskUserQuestion[];
  }

  private extractPlanContent(toolName: string, input: Record<string, unknown>): string | null {
    if (toolName !== 'ExitPlanMode') {
      return null;
    }

    return extractPlanText(input.plan);
  }
}
