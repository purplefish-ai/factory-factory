import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import {
  type ProviderSessionNotice,
  readCodexReconnectTitle,
} from '@/shared/acp-protocol/protocol/provider-session-notice';
import type { TranslatableSessionUpdate } from '@/shared/acp-protocol/session-update-translator';

export class AcpProviderNotices {
  private readonly activeReconnects = new Map<string, ProviderSessionNotice>();

  constructor(private readonly sessionDomainService: SessionDomainService) {}

  record(sid: string, notice: ProviderSessionNotice, retrying: boolean): void {
    const isReconnect = notice.provider === 'CODEX' && readCodexReconnectTitle(notice.title);
    if (!isReconnect) {
      this.sessionDomainService.upsertProviderNotice(sid, { type: 'session_notice', notice });
      return;
    }

    const reconnectingNotice: ProviderSessionNotice = {
      ...notice,
      reconnect: retrying ? 'retrying' : 'ended',
    };
    const stored = this.sessionDomainService.upsertProviderNotice(sid, {
      type: 'session_notice',
      notice: reconnectingNotice,
    });
    if (stored && retrying) {
      const active = this.activeReconnects.get(sid);
      if (active && active.id !== notice.id) {
        this.resolve(sid, 'ended');
      }
      this.activeReconnects.set(sid, reconnectingNotice);
    }
  }

  observeUpdate(sid: string, update: TranslatableSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (update.content?.type !== 'text' || !update.content.text) {
          return;
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
      case 'plan':
        break;
      default:
        return;
    }
    this.resolve(sid, 'recovered');
  }

  resolve(sid: string, reconnect: 'recovered' | 'ended'): void {
    const notice = this.activeReconnects.get(sid);
    if (notice) {
      this.activeReconnects.delete(sid);
      this.sessionDomainService.upsertProviderNotice(
        sid,
        {
          type: 'session_notice',
          notice: { ...notice, reconnect },
        },
        true
      );
    }
  }
}
