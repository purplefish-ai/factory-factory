import { useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** Edits a chat name beside the tabs, preserving their selection semantics. */
export function SessionNameEditor({
  sessionId,
  workspaceId,
  name,
  onDone,
}: {
  sessionId: string;
  workspaceId: string;
  name: string;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      mounted.current = false;
    };
  }, []);
  const [value, setValue] = useState(name);
  const [error, setError] = useState(false);
  // Enter and the blur it can cause both call save before React re-renders
  // with the mutation pending, so a ref blocks the second call.
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const utils = trpc.useUtils();
  const update = trpc.session.updateSession.useMutation({
    meta: { errorToast: false },
    // Stay pending until the tabs show the new name.
    onSuccess: () => utils.session.listSessions.invalidate({ workspaceId }),
  });
  const saving = update.isPending;
  const runIfMounted = (action: () => void) => {
    if (mounted.current) {
      action();
    }
  };
  const save = async () => {
    if (inFlight.current || cancelled.current) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      onDone();
      return;
    }
    inFlight.current = true;
    setError(false);
    try {
      await update.mutateAsync({ id: sessionId, name: trimmed });
      runIfMounted(onDone);
    } catch {
      runIfMounted(() => setError(true));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Popover open={error}>
      <PopoverAnchor asChild>
        <div className="relative shrink-0 p-1">
          <Input
            aria-label="Chat name"
            value={value}
            readOnly={saving}
            aria-busy={saving}
            aria-invalid={error}
            ref={inputRef}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => {
              if (!error) {
                void save();
              }
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              } else if (event.key === 'Escape' && !event.nativeEvent.isComposing && !saving) {
                event.preventDefault();
                cancelled.current = true;
                onDone();
              }
            }}
            className={cn('h-7 w-40 text-sm', saving && 'pr-7')}
          />
          {saving && (
            <Spinner
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
            />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        role="alert"
        aria-label="Chat rename error"
        side="bottom"
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="p-2 text-xs text-destructive"
      >
        Couldn't rename chat. Press Enter to retry or Escape to cancel.
      </PopoverContent>
    </Popover>
  );
}
