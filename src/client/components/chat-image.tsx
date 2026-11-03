import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
}

/** Inline-safe markup: Markdown images may occur inside paragraphs and links. */
export function ChatImage({
  src,
  alt,
  source,
  loading,
  title,
  interactive = true,
}: ChatImageProps) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const embedded = source ? /^data:/i.test(source) : false;
  if (!src || failed) {
    return (
      <span
        className={cn(
          'inline-flex max-w-full min-w-0 flex-col rounded border p-2 text-xs text-muted-foreground',
          embedded && 'w-80'
        )}
      >
        <span>
          {loading ? 'Loading image…' : 'Image unavailable'}
          {alt ? `: ${alt}` : ''}
        </span>
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
  const preview = (
    <img
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      className="my-0 max-h-80 max-w-full rounded object-contain"
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
        className="max-w-full cursor-zoom-in rounded focus-visible:outline focus-visible:outline-ring"
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
              {source && !embedded ? source : 'Full-size image preview'}
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
