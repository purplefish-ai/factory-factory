import {
  AcpPermissionBridge,
  type AcpPermissionRequestEvent,
} from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { ChatMessage, SessionDeltaEvent } from '@/shared/acp-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { buildQuestionToolDetails } from '@/shared/acp-protocol/protocol/question-response';
import { summarizeQuestionResponse } from '@/shared/acp-protocol/question-response-summary';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import {
  getAskUserQuestions,
  isExitPlanModeRequest,
  isUserQuestionRequest,
  type PendingInteractiveRequest,
} from '@/shared/pending-request-types';

type InteractiveRequest = {
  delta: SessionDeltaEvent;
  pending: PendingInteractiveRequest;
  question?: {
    order: number;
    providerSessionId?: string;
    isCurrent?: () => boolean;
    rawInput: Record<string, unknown>;
    resolveElicitationResponse?: AcpPermissionRequestEvent['resolveElicitationResponse'];
  };
};

export type SessionPermissionServiceDependencies = {
  sessionDomainService?: SessionDomainService;
  getProviderSessionId?: (sessionId: string) => string | undefined;
  persistQuestionResponse?: (
    sessionId: string,
    providerSessionId: string,
    message: ChatMessage
  ) => void;
};

export class SessionPermissionService {
  private readonly sessionDomainService: SessionDomainService;
  private readonly getProviderSessionId?: SessionPermissionServiceDependencies['getProviderSessionId'];
  private readonly persistQuestionResponse?: SessionPermissionServiceDependencies['persistQuestionResponse'];
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();
  /**
   * Outstanding user-facing requests per session, oldest first. Only the newest is the
   * session's pending interactive request; resolving it promotes the next one.
   */
  private readonly interactiveRequests = new Map<string, Map<string, InteractiveRequest>>();

  constructor(options?: SessionPermissionServiceDependencies) {
    this.sessionDomainService = options?.sessionDomainService ?? sessionDomainService;
    this.getProviderSessionId = options?.getProviderSessionId;
    this.persistQuestionResponse = options?.persistQuestionResponse;
  }

  createPermissionBridge(sessionId: string, workflow?: string): AcpPermissionBridge {
    const existing = this.acpPermissionBridges.get(sessionId);
    if (existing) {
      return existing;
    }

    const bridge = new AcpPermissionBridge(
      (requestId) => {
        const request = this.interactiveRequests.get(sessionId)?.get(requestId);
        this.recordQuestionResponse(sessionId, request, 'cancelled');
        const wasShown = this.forgetInteractiveRequest(sessionId, requestId);
        this.sessionDomainService.emitDelta(sessionId, { type: 'permission_cancelled', requestId });
        if (wasShown && this.acpPermissionBridges.get(sessionId)?.pendingCount) {
          this.showNextInteractiveRequest(sessionId);
        }
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

    this.acpPermissionBridges.delete(sessionId);
    bridge.cancelAll();
    this.interactiveRequests.delete(sessionId);
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

    const resolved = bridge.resolvePermission(requestId, optionId, answers);
    if (!resolved) {
      return false;
    }

    const request = this.interactiveRequests.get(sessionId)?.get(requestId);
    const selected = request?.pending.acpOptions?.find((option) => option.optionId === optionId);
    const allowed = selected?.kind === 'allow_once' || selected?.kind === 'allow_always';
    const elicitation = request?.question?.resolveElicitationResponse?.(optionId, answers);
    const accepted = elicitation ? elicitation.action === 'accept' : allowed;
    this.recordQuestionResponse(sessionId, request, accepted ? 'answered' : 'cancelled', answers);
    if (this.forgetInteractiveRequest(sessionId, requestId)) {
      this.showNextInteractiveRequest(sessionId);
    }
    return true;
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

    const delta: SessionDeltaEvent = isUserQuestion
      ? { type: 'user_question', requestId, toolName, questions, acpOptions }
      : {
          type: 'permission_request',
          requestId,
          toolName,
          ...(rawToolName ? { rawToolName } : {}),
          toolUseId: params.toolCall.toolCallId,
          toolInput,
          ...(event.elicitation ? { elicitation: event.elicitation } : {}),
          planContent,
          acpOptions,
        };
    const request: InteractiveRequest = {
      delta,
      ...(isUserQuestion
        ? { question: this.captureQuestion(sessionId, toolInput, event.resolveElicitationResponse) }
        : {}),
      pending: {
        requestId,
        toolName,
        toolUseId: params.toolCall.toolCallId,
        ...(rawToolName ? { rawToolName } : {}),
        input: pendingInput,
        ...(event.elicitation ? { elicitation: event.elicitation } : {}),
        planContent,
        acpOptions,
        timestamp: new Date().toISOString(),
      },
    };

    this.registerInteractiveRequest(sessionId, request);
  }

  private registerInteractiveRequest(sessionId: string, request: InteractiveRequest): void {
    const { requestId } = request.pending;
    let requests = this.interactiveRequests.get(sessionId);
    if (!requests) {
      requests = new Map();
      this.interactiveRequests.set(sessionId, requests);
    }
    requests.delete(requestId);
    requests.set(requestId, request);
    this.showInteractiveRequest(sessionId, request);
  }

  private captureQuestion(
    sessionId: string,
    rawInput: Record<string, unknown>,
    resolveElicitationResponse: AcpPermissionRequestEvent['resolveElicitationResponse']
  ): NonNullable<InteractiveRequest['question']> {
    const providerSessionId = this.getProviderSessionId?.(sessionId);
    const fence = providerSessionId
      ? this.sessionDomainService.createProviderHistoryFence(sessionId, providerSessionId)
      : undefined;
    return {
      order: this.sessionDomainService.allocateOrder(sessionId),
      providerSessionId,
      isCurrent: fence === null ? () => false : fence,
      rawInput,
      resolveElicitationResponse,
    };
  }

  private recordQuestionResponse(
    sessionId: string,
    request: InteractiveRequest | undefined,
    status: 'answered' | 'cancelled',
    answers?: Record<string, string[]>
  ): void {
    if (!(request?.question && request.pending.toolUseId)) {
      return;
    }
    const { rawInput, order, providerSessionId, isCurrent } = request.question;
    if (isCurrent?.() === false) {
      return;
    }
    const { requestId, toolUseId, timestamp, toolName } = request.pending;
    const questionResponse = summarizeQuestionResponse(
      rawInput,
      { requestId, toolUseId },
      status,
      answers
    );
    const details = questionResponse.questions.some((item) => item.redacted)
      ? undefined
      : buildQuestionToolDetails(toolName, rawInput);
    const message = this.sessionDomainService.upsertQuestionResponse(sessionId, order, {
      type: 'question_response',
      questionResponse,
      questionToolDetails: details,
      timestamp,
    });
    if (providerSessionId) {
      this.persistQuestionResponse?.(sessionId, providerSessionId, message);
    }
  }

  private showInteractiveRequest(sessionId: string, request: InteractiveRequest): void {
    this.sessionDomainService.emitDelta(sessionId, request.delta);
    this.sessionDomainService.setPendingInteractiveRequest(sessionId, request.pending);
  }

  /**
   * Forget a resolved or cancelled request. Returns whether it was the request shown to
   * the user, in which case the caller shows the next one.
   */
  private forgetInteractiveRequest(sessionId: string, requestId: string): boolean {
    const requests = this.interactiveRequests.get(sessionId);
    if (requests?.delete(requestId) && requests.size === 0) {
      this.interactiveRequests.delete(sessionId);
    }
    return this.sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
  }

  /** Show the newest request still awaiting a response so it is not stranded without UI. */
  private showNextInteractiveRequest(sessionId: string): void {
    const requests = this.interactiveRequests.get(sessionId);
    if (!requests) {
      return;
    }
    const bridge = this.acpPermissionBridges.get(sessionId);
    for (const [requestId, request] of [...requests].reverse()) {
      if (bridge?.hasPending(requestId)) {
        this.showInteractiveRequest(sessionId, request);
        return;
      }
      requests.delete(requestId);
    }
    this.interactiveRequests.delete(sessionId);
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
