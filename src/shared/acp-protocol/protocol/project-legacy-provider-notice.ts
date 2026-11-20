import type { ChatMessage } from './messages';
import { readCodexReconnectTitle } from './provider-session-notice';

export function projectLegacyProviderNotice(row: ChatMessage, provider: unknown): ChatMessage {
  if (provider === 'CLAUDE' && row.source === 'user' && !row.attachments?.length) {
    const text = row.text?.trim();
    if (
      text === '[Request interrupted by user]' ||
      text === '[Request interrupted by user for tool use]'
    ) {
      return {
        ...row,
        source: 'agent',
        text: undefined,
        message: {
          type: 'session_notice',
          notice: {
            id: row.id,
            revision: 0,
            provider,
            severity: 'info',
            title: 'Request interrupted',
          },
        },
      };
    }
  }
  if (provider !== 'CODEX' || row.source !== 'agent' || row.message?.type !== 'assistant') {
    return row;
  }
  const content = row.message.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : content?.length === 1 && content[0]?.type === 'text'
        ? content[0].text
        : undefined;
  const title = text?.trim().replace(/^Warning: /, '');
  if (!(title && readCodexReconnectTitle(title))) {
    return row;
  }
  return {
    ...row,
    message: {
      type: 'session_notice',
      notice: {
        id: row.id,
        revision: 0,
        provider,
        severity: 'warning',
        category: 'connection',
        title,
        reconnect: 'ended',
      },
    },
  };
}
