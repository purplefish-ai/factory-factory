import type { ReactNode } from 'react';
import { ImageDropZone } from '@/client/features/composer';
import type { ChatContentProps } from './workspace-detail-chat-content';

type WorkspaceChatImageDropZoneProps = Pick<
  ChatContentProps,
  | 'workspaceId'
  | 'sessionId'
  | 'connected'
  | 'sessionStatus'
  | 'chatCapabilities'
  | 'inputAttachments'
  | 'setInputAttachments'
  | 'inputRef'
> & { children: ReactNode };

export function WorkspaceChatImageDropZone(props: WorkspaceChatImageDropZoneProps) {
  return (
    <ImageDropZone
      dropIdentity={`${props.workspaceId}/${props.sessionId ?? 'none'}`}
      disabled={
        !(props.sessionId && props.connected) ||
        props.sessionStatus.phase === 'loading' ||
        !props.chatCapabilities.attachments.enabled ||
        !props.chatCapabilities.attachments.kinds.includes('image')
      }
      label="Drop images to attach to your message"
      onAttachments={(attachments) => {
        props.setInputAttachments([...props.inputAttachments, ...attachments]);
        props.inputRef.current?.focus();
      }}
    >
      {props.children}
    </ImageDropZone>
  );
}
