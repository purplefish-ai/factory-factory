import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  SessionResumeFences,
  sessionResumeFences,
} from '@/backend/services/session/service/session-resume-fence';
import type { QueuedMessage } from '@/shared/acp-protocol';
import {
  type ClaimedPRDelivery,
  PR_EVENT_MESSAGE_ID_PREFIX,
  type PRDeliveryRequest,
} from '@/shared/pr-monitoring';
import { prDeliveryRequestSchema } from '@/shared/schemas/pr-event.schema';
export interface PRBackgroundDeliveryPort {
  prepare(input: {
    sessionId: string;
    request: PRDeliveryRequest;
  }): Promise<
    | { status: 'ready'; delivery: ClaimedPRDelivery }
    | { status: 'blocked'; reason: string }
    | { status: 'discard' }
  >;
  validate(delivery: ClaimedPRDelivery): Promise<boolean>;
  complete(delivery: ClaimedPRDelivery): Promise<void>;
  fail(delivery: ClaimedPRDelivery, error: unknown): Promise<void>;
  recover(sessionId: string): Promise<void>;
  pause(sessionId: string, reason: 'USER_STOPPED' | 'SESSION_FAILED'): Promise<void>;
  resume(sessionId: string, isCurrent?: () => boolean): Promise<void>;
}
export class SessionBackgroundDeliveryService {
  private port: PRBackgroundDeliveryPort | null = null;
  private tokens = new Map<
    string,
    { sessionId: string; messageId: string; request: PRDeliveryRequest }
  >();
  private deliveries = new Map<string, ClaimedPRDelivery>();
  constructor(private readonly resumeFences = new SessionResumeFences()) {}
  configure(port: PRBackgroundDeliveryPort) {
    this.port = port;
  }
  enqueue(sessionId: string, rawRequest: PRDeliveryRequest): { queued: boolean; reason?: string } {
    const request = prDeliveryRequestSchema.parse(rawRequest);
    const key = `${sessionId}:${request.workspaceId}:${request.prId ?? 'control'}:${request.bindingRevision}:${request.deliveryMode ?? 'MAIN'}`;
    const existing = this.tokens.get(key);
    if (existing && sessionDomainService.hasQueuedMessage(sessionId, existing.messageId)) {
      return { queued: true };
    }
    this.tokens.delete(key);
    const messageId = `${PR_EVENT_MESSAGE_ID_PREFIX}queued-${key}`;
    const result = sessionDomainService.enqueue(sessionId, {
      id: messageId,
      text: 'PR update queued for the next turn',
      timestamp: new Date().toISOString(),
      source: { type: 'pr_event', request },
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    if ('error' in result) {
      return { queued: false, reason: result.error };
    }
    this.tokens.set(key, { sessionId, messageId, request });
    return { queued: true };
  }
  invalidate(workspaceId: string, bindingRevision: number) {
    for (const [key, token] of this.tokens) {
      if (
        token.request.workspaceId === workspaceId &&
        token.request.bindingRevision === bindingRevision
      ) {
        sessionDomainService.removeQueuedMessage(token.sessionId, token.messageId);
        this.tokens.delete(key);
      }
    }
  }
  async prepare(sessionId: string, message: QueuedMessage) {
    if (!(message.source && this.port)) {
      this.forgetToken(message.id);
      return { status: 'discard' as const };
    }
    const result = await this.port.prepare({ sessionId, request: message.source.request });
    if (result.status === 'discard') {
      this.forgetToken(message.id);
    }
    if (result.status === 'ready') {
      message.text = result.delivery.text;
      this.deliveries.set(message.id, result.delivery);
    }
    return result;
  }
  private forgetToken(messageId: string) {
    for (const [key, token] of this.tokens) {
      if (token.messageId === messageId) {
        this.tokens.delete(key);
      }
    }
  }
  isDeliveryActive(deliveryId: string): boolean {
    for (const delivery of this.deliveries.values()) {
      if (delivery.deliveryId === deliveryId) {
        return true;
      }
    }
    return false;
  }
  async validate(message: QueuedMessage) {
    const delivery = this.deliveries.get(message.id);
    return !!delivery && !!this.port && (await this.port.validate(delivery));
  }
  async complete(message: QueuedMessage) {
    const delivery = this.deliveries.get(message.id);
    if (delivery && this.port) {
      try {
        await this.port.complete(delivery);
      } finally {
        this.deliveries.delete(message.id);
        if (!sessionDomainService.hasQueuedMessage(delivery.sessionId, message.id)) {
          this.forgetToken(message.id);
        }
      }
    }
  }
  async fail(message: QueuedMessage, error: unknown) {
    const delivery = this.deliveries.get(message.id);
    if (delivery && this.port) {
      try {
        await this.port.fail(delivery, error);
      } finally {
        this.deliveries.delete(message.id);
      }
    }
  }
  recover(sessionId: string) {
    return this.port?.recover(sessionId) ?? Promise.resolve();
  }
  captureResumeGuard(sessionId: string): () => boolean {
    return this.resumeFences.capture(sessionId);
  }
  async userStop(sessionId: string) {
    this.resumeFences.advance(sessionId);
    await this.port?.pause(sessionId, 'USER_STOPPED');
  }
  async runtimeFailure(sessionId: string) {
    this.resumeFences.advance(sessionId);
    await this.port?.pause(sessionId, 'SESSION_FAILED');
  }
  async userResume(sessionId: string, isCurrent = this.captureResumeGuard(sessionId)) {
    if (!isCurrent()) {
      return;
    }
    await this.port?.resume(sessionId, isCurrent);
  }
}
export const sessionBackgroundDeliveryService = new SessionBackgroundDeliveryService(
  sessionResumeFences
);
