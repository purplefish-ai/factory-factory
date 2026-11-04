import { useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Input } from '@/components/ui/input';

/** Replaces a chat tab while its name is being edited. */
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
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const [value, setValue] = useState(name);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const utils = trpc.useUtils();
  const update = trpc.session.updateSession.useMutation();
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
      onDone();
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
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
          } else if (event.key === 'Escape' && !saving) {
            event.preventDefault();
            cancelled.current = true;
            onDone();
          }
        }}
        className="h-7 w-40 text-sm"
      />
      {error && (
        <p
          role="alert"
          className="absolute left-0 top-full z-30 rounded border bg-background p-2 text-xs text-destructive shadow"
        >
          Couldn't rename chat. Press Enter to retry or Escape to cancel.
        </p>
      )}
    </div>
  );
}
