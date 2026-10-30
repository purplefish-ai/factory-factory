import { createContext, useContext } from 'react';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

/**
 * Carries the streamed chat props past the memoized workspace layout.
 *
 * Every streamed chat event re-renders the workspace container. Passing the chat
 * props down as regular props would re-render the tab bar, right panel and other
 * layout between the container and the chat. Consumers of this context update on
 * their own while that layout bails out.
 */
const ChatContentPropsContext = createContext<ChatContentProps | null>(null);

export const ChatContentPropsProvider = ChatContentPropsContext.Provider;

function ConnectedChatContent() {
  const props = useContext(ChatContentPropsContext);
  if (!props) {
    throw new Error('ConnectedChatContent must be rendered inside ChatContentPropsProvider');
  }
  return <ChatContent {...props} />;
}

/** A constant element, so memoized parents that receive it as children can bail out. */
export const CONNECTED_CHAT_CONTENT = <ConnectedChatContent />;
