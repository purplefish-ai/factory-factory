import {
  AcpPermissionBridge,
  type AcpPermissionRequestEvent,
} from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import {
  getAskUserQuestions,
  isExitPlanModeRequest,
  isUserQuestionRequest,
} from '@/shared/pending-request-types';

export type SessionPermissionServiceDependencies = {
  sessionDomainService?: SessionDomainService;
};

export class SessionPermissionService {
  private readonly sessionDomainService: SessionDomainService;
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();

  constructor(options?: SessionPermissionServiceDependencies) {
    this.sessionDomainService = options?.sessionDomainService ?? sessionDomainService;
  }

  createPermissionBridge(sessionId: string, workflow?: string): AcpPermissionBridge {
    const existing = this.acpPermissionBridges.get(sessionId);
    if (existing) {
      return existing;
    }

    const bridge = new AcpPermissionBridge(
      (requestId) => {
        this.sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
        this.sessionDomainService.emitDelta(sessionId, { type: 'permission_cancelled', requestId });
      },
      workflow === ADVERSARIAL_REVIEW_WORKFLOW
        ? (params) => {
            const reject = params.options.find(
              (option) => option.kind === 'reject_once' || option.kind === 'reject_always'
            );
            return reject
              ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
              : { outcome: { outcome: 'cancelled' } };
          }
        : undefined
    );
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
    if (this.acpPermissionBridges.get(sessionId)?.resolveAutomaticPermission(params)) {
      return;
    }
    const toolInput = (params.toolCall.rawInput as Record<string, unknown>) ?? {};
    const toolName = this.resolveToolName(params.toolCall.title, toolInput);
    const rawToolName =
      typeof params.toolCall.name === 'string'
        ? params.toolCall.name
        : params.toolCall.title?.startsWith('mcp__')
          ? params.toolCall.title
          : undefined;
    const acpOptions = params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const planContent = this.extractPlanContent(toolName, toolInput);
    const isUserQuestion = isUserQuestionRequest({ toolName, rawToolName, input: toolInput });
    const questions = isUserQuestion ? getAskUserQuestions(toolInput) : [];
    const pendingInput = isUserQuestion ? { ...toolInput, questions } : toolInput;

    if (isUserQuestion) {
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
      ...(rawToolName ? { rawToolName } : {}),
      input: pendingInput,
      planContent,
      acpOptions,
      timestamp: new Date().toISOString(),
    });
  }

  private extractPlanContent(toolName: string, input: Record<string, unknown>): string | null {
    if (!isExitPlanModeRequest({ toolName, input })) {
      return null;
    }

    return extractPlanText(input.plan);
  }

  private resolveToolName(
    title: string | null | undefined,
    input: Record<string, unknown>
  ): string {
    if (title?.startsWith('mcp__')) {
      return title;
    }
    const type = input.type;
    if (type === 'AskUserQuestion' || type === 'ExitPlanMode') {
      return type;
    }

    return title ?? 'ACP Tool';
  }
}
