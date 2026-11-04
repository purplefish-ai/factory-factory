import { useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

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
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const utils = trpc.useUtils();
  const update = trpc.session.updateSession.useMutation({ meta: { errorToast: false } });
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
    setSaving(true);
    setError(false);
    try {
      await update.mutateAsync({ id: sessionId, name: trimmed });
      await utils.session.listSessions.invalidate({ workspaceId });
      runIfMounted(onDone);
    } catch {
      runIfMounted(() => setError(true));
    } finally {
      inFlight.current = false;
      runIfMounted(() => setSaving(false));
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
            className="h-7 w-40 text-sm"
          />
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
