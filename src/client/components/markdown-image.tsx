import { useContext } from 'react';
import { trpc } from '@/client/lib/trpc';
import { ChatImage, imageDataUrl } from './chat-image';
import { ChatImageWorkspaceContext } from './chat-image-context';

function localPath(src: string): string | null {
  try {
    if (src.startsWith('file:')) {
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
  alt,
  source,
}: {
  workspaceId: string;
  path: string;
  alt: string;
  source: string;
}) {
  const query = trpc.workspace.readChatImage.useQuery(
    { workspaceId, path },
    { retry: false, staleTime: 60_000, refetchOnWindowFocus: false }
  );
  const src = query.data && imageDataUrl(query.data.mimeType, query.data.data);
  return (
    <ChatImage
      key={src || source}
      src={src || undefined}
      alt={alt}
      source={source}
      loading={query.isPending}
    />
  );
}

export function MarkdownImage({ src, alt = 'Image' }: { src?: string; alt?: string }) {
  const workspaceId = useContext(ChatImageWorkspaceContext);
  const path = src ? localPath(src) : null;
  if (path && workspaceId && src) {
    return <LocalImage workspaceId={workspaceId} path={path} alt={alt} source={src} />;
  }
  let imageSrc: string | undefined;
  if (src && /^(https?:\/\/|\/\/)/i.test(src)) {
    imageSrc = src;
  } else if (src?.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(src);
    imageSrc = match ? (imageDataUrl(match[1] ?? '', match[2] ?? '') ?? undefined) : undefined;
  }
  return <ChatImage key={src} src={imageSrc} alt={alt} source={src} />;
}
