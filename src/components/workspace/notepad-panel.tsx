import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface NotepadPanelProps {
  workspaceId: string;
  className?: string;
}

export function NotepadPanel({ workspaceId, className }: NotepadPanelProps) {
  const utils = trpc.useUtils();

  const { data: workspace } = trpc.workspace.get.useQuery({ id: workspaceId });

  // Read from React Query cache synchronously on mount
  const cachedWorkspace = utils.workspace.get.getData({ id: workspaceId });

  const [notepad, setNotepad] = useState(() => cachedWorkspace?.notepad ?? '');
  const [isSaving, setIsSaving] = useState(false);

  // If cache had data on mount, we're already initialized — skip server sync.
  // Only sync from server on cold start (no cache).
  const initializedRef = useRef(!!cachedWorkspace);

  useEffect(() => {
    if (!initializedRef.current && workspace?.notepad !== undefined) {
      initializedRef.current = true;
      setNotepad(workspace.notepad ?? '');
    }
  }, [workspace?.notepad]);

  const updateNotepadMutation = trpc.workspace.updateNotepad.useMutation({
    onMutate: async ({ notepad: newNotepad }) => {
      await utils.workspace.get.cancel({ id: workspaceId });
      utils.workspace.get.setData({ id: workspaceId }, (old) => {
        if (!old) {
          return old;
        }
        return { ...old, notepad: newNotepad };
      });
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  useEffect(() => {
    if (!workspace || notepad === (workspace.notepad ?? '')) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setIsSaving(true);
      updateNotepadMutation.mutate({
        workspaceId,
        notepad: notepad || null,
      });
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [notepad, workspace, workspaceId, updateNotepadMutation]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNotepad(e.target.value);
  }, []);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <span className="text-sm font-medium">Notes</span>
        {isSaving && <span className="text-xs text-muted-foreground">Saving...</span>}
      </div>
      <div className="flex-1 p-3 overflow-auto">
        <Textarea
          value={notepad}
          onChange={handleChange}
          placeholder="Add notes about this workspace..."
          className="min-h-[200px] resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 p-0 font-mono text-sm"
        />
      </div>
    </div>
  );
}
