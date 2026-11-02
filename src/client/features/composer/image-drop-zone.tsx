import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { type DragEvent, type ReactNode, useInsertionEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { collectAttachments } from './hooks/attachment-file-conversion';

interface ImageDropZoneProps {
  children: ReactNode;
  className?: string;
  dropIdentity: string;
  disabled?: boolean;
  label: string;
  onDropAccepted?: () => void;
  onAttachments: (attachments: MessageAttachment[]) => void;
}

function hasImages(transfer: DataTransfer) {
  return (
    Array.from(transfer.items).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    ) || Array.from(transfer.files).some((file) => file.type.startsWith('image/'))
  );
}

/** A view-wide image target that takes precedence over nested composer drop handlers. */
export function ImageDropZone({
  children,
  className,
  dropIdentity,
  disabled = false,
  label,
  onDropAccepted,
  onAttachments,
}: ImageDropZoneProps) {
  const [draggingIdentity, setDraggingIdentity] = useState<{
    identity: string;
    token: object | null;
  } | null>(null);
  const depth = useRef(0);
  const lifetime = useRef<object | null>(null);
  const attach = useStableCallback(onAttachments);

  // Never deliver a slow file read to a replacement session, even after A -> B -> A.
  useInsertionEffect(() => {
    lifetime.current = { dropIdentity, disabled };
    depth.current = 0;
    return () => {
      lifetime.current = null;
    };
  }, [dropIdentity, disabled]);

  const reset = () => {
    depth.current = 0;
    setDraggingIdentity(null);
  };
  const capture = (event: DragEvent<HTMLDivElement>) => {
    if (
      !(
        event.target instanceof Node &&
        event.currentTarget.contains(event.target) &&
        hasImages(event.dataTransfer)
      )
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    reset();
    if (!capture(event) || disabled) {
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) {
      return;
    }
    const token = lifetime.current;
    onDropAccepted?.();
    void collectAttachments(files).then(({ attachments, errors }) => {
      if (lifetime.current !== token) {
        return;
      }
      if (attachments.length > 0) {
        attach(attachments);
      }
      if (errors.length > 0) {
        toast.error(errors.map(({ fileName, message }) => `${fileName}: ${message}`).join('; '));
      }
    });
  };

  return (
    <div
      className={cn('relative h-full min-h-0', className)}
      onDragEnterCapture={(event) => {
        if (capture(event) && !disabled) {
          depth.current += 1;
          setDraggingIdentity({ identity: dropIdentity, token: lifetime.current });
        }
      }}
      onDragOverCapture={(event) => {
        if (capture(event)) {
          event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
          if (!disabled) {
            setDraggingIdentity({ identity: dropIdentity, token: lifetime.current });
          }
        }
      }}
      onDragLeaveCapture={(event) => {
        if (depth.current > 0) {
          event.stopPropagation();
          depth.current -= 1;
          if (depth.current === 0) {
            reset();
          }
        }
      }}
      onDragEndCapture={reset}
      onDropCapture={handleDrop}
    >
      {children}
      {!disabled &&
        draggingIdentity?.identity === dropIdentity &&
        draggingIdentity.token === lifetime.current && (
          <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 p-6">
            <div
              role="status"
              className="flex flex-col items-center gap-3 text-center text-primary"
            >
              <ImageIcon className="size-10" aria-hidden="true" />
              <p className="text-lg font-medium">{label}</p>
            </div>
          </div>
        )}
    </div>
  );
}
