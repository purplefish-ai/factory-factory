import { useContext } from 'react';
import { QUERY_RETRY } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { MarkdownLinkContext } from '@/components/ui/markdown';
import { ChatImage, imageDataUrl, type ChatImageProps } from './chat-image';
import { ChatImageWorkspaceContext } from './chat-image-context';

function localPath(src: string): string | null {
  try {
    if (/^file:/i.test(src)) {
      const url = new URL(src);
      if (url.hostname) {
        return null;
      }
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    }
    if (
      /^[A-Za-z]:(?:[\\/]|%5C)/i.test(src) ||
      !(/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//'))
    ) {
      return decodeURIComponent(src);
    }
  } catch {
    /* Malformed paths retain their visible fallback. */
  }
  return null;
}

function LocalImage({
  workspaceId,
  path,
  source,
  ...imageProps
}: {
  workspaceId: string;
  path: string;
  source: string;
} & Pick<ChatImageProps, 'alt' | 'title' | 'interactive'>) {
  const query = trpc.workspace.readChatImage.useQuery(
    { workspaceId, path },
    { retry: QUERY_RETRY.permanentServerError, staleTime: 60_000 }
  );
  const src = query.data && imageDataUrl(query.data.mimeType, query.data.data);
  return (
    <ChatImage
      key={src || source}
      src={src || undefined}
      {...imageProps}
      source={source}
      loading={query.isPending}
    />
  );
}

export function MarkdownImage({
  src,
  alt = 'Image',
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const workspaceId = useContext(ChatImageWorkspaceContext);
  const linked = useContext(MarkdownLinkContext);
  const path = src ? localPath(src) : null;
  if (path && workspaceId && src) {
    return (
      <LocalImage
        workspaceId={workspaceId}
        path={path}
        alt={alt}
        source={src}
        title={title}
        interactive={!linked}
      />
    );
  }
  let imageSrc: string | undefined;
  if (src && /^(https?:\/\/|\/\/)/i.test(src)) {
    imageSrc = src;
  } else if (src && /^data:/i.test(src)) {
    const match = /^data:([^;,]+);base64,(.*)$/i.exec(src);
    imageSrc = match ? (imageDataUrl(match[1] ?? '', match[2] ?? '') ?? undefined) : undefined;
  }
  return (
    <ChatImage
      key={src}
      src={imageSrc}
      alt={alt}
      source={src}
      title={title}
      interactive={!linked}
    />
  );
}
