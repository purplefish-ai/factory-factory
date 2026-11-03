import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';

export type InboxNotification =
  | { kind: 'mail'; workspaceId: string; revision: string }
  | { kind: 'message'; title: string; body: string };

function getEventNotification(event: AgentMessage | undefined): InboxNotification | null {
  if (event?.type === 'child_workspace_update' || event?.type === 'parent_workspace_update') {
    const child = event.type === 'child_workspace_update';
    return {
      kind: 'message',
      title: `${child ? 'Child' : 'Parent'} workspace · ${
        (child ? event.childWorkspaceName : event.parentWorkspaceName) ?? 'Workspace message'
      }`,
      body: event.text ?? '',
    };
  }
  return null;
}

export function getInboxNotification(message: ChatMessage): InboxNotification | null {
  const eventNotification = getEventNotification(message.message);
  if (eventNotification) {
    return eventNotification;
  }
  if (message.source !== 'user' || message.attachments?.length) {
    return null;
  }
  const text = message.text ?? '';
  // Match the entire signal: provider history may combine it with real user instructions.
  const mail =
    /^You have workspace mail \(revision (\d+)\)\. Use list_mail to inspect summaries, read_mail for selected bodies, and ack_mail with the observed revision after inspection\. Mail acknowledgement is separate from task completion\.\s+<!-- workspace-mail-wake-([^\s<>]+):(\d+) -->$/.exec(
      text.trim()
    );
  if (mail?.[1] && mail[1] === mail[3] && mail[2]) {
    return { kind: 'mail', workspaceId: mail[2], revision: mail[1] };
  }
  const legacy =
    /^\[Message from (parent|child) workspace "([^\n]*)"\]: ([\s\S]*)\n\n<!-- factory-factory-workspace-notification:[^\s<>]+ -->$/.exec(
      text.trim()
    );
  if (legacy) {
    return {
      kind: 'message',
      title: `${legacy[1] === 'parent' ? 'Parent' : 'Child'} workspace · ${legacy[2]}`,
      body: legacy[3] ?? '',
    };
  }
  if (message.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX)) {
    return { kind: 'message', title: 'Workspace notification', body: text };
  }
  return null;
}
