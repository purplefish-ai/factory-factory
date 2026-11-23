import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';

export function imageDataUrl(mediaType: string, data: string): string | null {
  if (
    !(/^image\/(png|jpeg|jpg|gif|webp)$/.test(mediaType) && data) ||
    data.length > Math.ceil(MAX_IMAGE_SIZE / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    return null;
  }
  return `data:${mediaType};base64,${data}`;
}

export interface ChatImageProps {
  src?: string;
  alt: string;
  source?: string;
  loading?: boolean;
  title?: string;
  interactive?: boolean;
  /** Intrinsic size when known, so the transcript reserves the space before loading. */
  width?: number;
  height?: number;
  /** Offer to load a failed `src` again, for images the server may serve later. */
  retryable?: boolean;
}

function ChatImageFallback({
  alt,
  source,
  loading,
  interactive,
  onRetry,
}: Pick<ChatImageProps, 'alt' | 'source' | 'loading'> & {
  interactive: boolean;
  onRetry?: () => void;
}) {
  const embedded = source ? /^data:/i.test(source) : false;
  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 flex-col rounded border p-2 text-xs text-muted-foreground',
        embedded && 'w-80'
      )}
    >
      <span>
        {loading ? (
          <>
            <Spinner className="mr-1 inline size-3 align-text-bottom" aria-hidden="true" />
            Loading image…
          </>
        ) : (
          'Image unavailable'
        )}
        {alt ? `: ${alt}` : ''}
      </span>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-1 self-start"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRetry();
          }}
        >
          Retry
        </Button>
      )}
      {source &&
        (embedded && interactive ? (
          <textarea
            aria-label="Image source"
            readOnly
            rows={2}
            wrap="off"
            value={source}
            className="w-full min-w-0 max-w-full resize-none rounded border bg-muted p-1 font-mono text-xs"
          />
        ) : (
          <code className="max-h-24 overflow-auto select-text whitespace-pre-wrap break-all">
            {source}
          </code>
        ))}
    </span>
  );
}

/** Inline-safe markup: Markdown images may occur inside paragraphs and links. */
export function ChatImage({
  src,
  alt,
  source,
  loading,
  title,
  interactive = true,
  width,
  height,
  retryable = false,
}: ChatImageProps) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (!src || failed) {
    return (
      <ChatImageFallback
        alt={alt}
        source={source}
        loading={loading}
        interactive={interactive}
        onRetry={retryable && src ? () => setFailed(false) : undefined}
      />
    );
  }
  const preview = (
    <img
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      width={width}
      height={height}
      style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}
      className="my-0 h-auto max-h-80 max-w-full rounded object-contain"
      onError={() => setFailed(true)}
    />
  );
  if (!interactive) {
    return preview;
  }
  return (
    <span className="inline-flex max-w-full flex-col align-top">
      <button
        type="button"
        aria-label={`Open ${alt} at full size`}
        className="max-w-full cursor-zoom-in rounded focus-ring"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {preview}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-[95vw] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{alt}</DialogTitle>
            <DialogDescription className="break-all">
              {source && !/^data:/i.test(source) ? source : 'Full-size image preview'}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto">
            <img src={src} alt={alt} title={title} className="mx-auto max-w-none" />
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
