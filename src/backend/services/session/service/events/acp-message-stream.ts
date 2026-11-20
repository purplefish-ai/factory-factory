import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { AgentMessage } from '@/shared/acp-protocol';

type AssistantStream = {
  providerId?: string;
  messageId: string;
  order: number;
  text: string;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
};

/** Tracks the open provider message separately from its server-assigned transcript identity. */
export class AcpMessageStream {
  private readonly assistants = new Map<string, AssistantStream>();
  private readonly users = new Map<string, { providerId: string; messageId: string }>();

  constructor(
    private readonly domain: SessionDomainService,
    private readonly intervalMs: number
  ) {}

  appendUser(sid: string, text: string, providerId?: string): void {
    if (!text) {
      return;
    }
    this.finishAssistant(sid);
    const user = this.users.get(sid);
    if (user && user.providerId === providerId) {
      user.messageId = this.domain.injectCommittedUserMessage(sid, text, {
        appendTo: user.messageId,
      });
      return;
    }
    const messageId = this.domain.injectCommittedUserMessage(sid, text);
    if (providerId !== undefined) {
      this.users.set(sid, { providerId, messageId });
    } else {
      // Without an ID adjacent user updates can be distinct historical prompts.
      this.users.delete(sid);
    }
  }

  appendAssistant(sid: string, data: AgentMessage, providerId?: string): void {
    const content = data.message?.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    if (first?.type !== 'text' || !first.text) {
      return;
    }

    this.users.delete(sid);
    let stream = this.assistants.get(sid);
    if (stream && stream.providerId !== providerId) {
      this.finishAssistant(sid);
      stream = undefined;
    }
    const order = stream?.order ?? this.domain.allocateOrder(sid);
    const text = (stream?.text ?? '') + first.text;
    const messageId = this.domain.upsertClaudeEvent(
      sid,
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
      order
    );
    if (!stream) {
      stream = { providerId, order, messageId, text, pending: first.text };
      this.assistants.set(sid, stream);
    } else {
      stream.text = text;
      stream.pending += first.text;
    }
    if (!stream.timer) {
      const active = stream;
      stream.timer = setTimeout(() => this.flush(sid, active), this.intervalMs);
    }
  }

  /** Interleaved events flush pending text. Identified messages can resume in their original row. */
  interrupt(sid: string): void {
    const stream = this.assistants.get(sid);
    if (!stream) {
      return;
    }
    this.flush(sid, stream);
    if (stream.providerId === undefined) {
      this.assistants.delete(sid);
    }
  }

  clear(sid: string): void {
    this.users.delete(sid);
    this.finishAssistant(sid);
  }

  private finishAssistant(sid: string): void {
    const stream = this.assistants.get(sid);
    if (!stream) {
      return;
    }
    this.flush(sid, stream);
    this.assistants.delete(sid);
  }

  private flush(sid: string, stream: AssistantStream): void {
    clearTimeout(stream.timer);
    stream.timer = undefined;
    const text = stream.pending;
    if (!text) {
      return;
    }
    stream.pending = '';
    this.domain.emitDelta(sid, {
      type: 'assistant_text_delta',
      messageId: stream.messageId,
      order: stream.order,
      offset: stream.text.length - text.length,
      text,
    });
  }
}
