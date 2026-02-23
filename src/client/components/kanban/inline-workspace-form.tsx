import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { useProjectFileMentions } from '@/components/chat/chat-input/hooks/use-project-file-mentions';
import { FileMentionPalette } from '@/components/chat/file-mention-palette';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RatchetToggleButton } from '@/components/workspace';
import {
  generateUniqueWorkspaceName,
  generateWorkspaceNameFromPrompt,
} from '@/shared/workspace-words';

interface InlineWorkspaceFormProps {
  projectId: string;
  existingNames: string[];
  onCancel: () => void;
  onCreated: () => void;
}

export function InlineWorkspaceForm({
  projectId,
  existingNames,
  onCancel,
  onCreated,
}: InlineWorkspaceFormProps) {
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const [provider, setProvider] = useState<'CLAUDE' | 'CODEX'>('CLAUDE');

  const fileMentions = useProjectFileMentions({
    projectId,
    inputRef: textareaRef,
    onChange: setInitialPrompt,
  });

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Initialize defaults from user settings once loaded
  useEffect(() => {
    if (!userSettings) {
      return;
    }
    setRatchetEnabled(userSettings.ratchetEnabled);
    setProvider(userSettings.defaultSessionProvider);
  }, [userSettings]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: () => {
      utils.workspace.listWithKanbanState.invalidate({ projectId });
      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      onCreated();
    },
    onError: (error) => {
      toast.error(`Failed to create workspace: ${error.message}`);
    },
  });

  const isCreating = createWorkspaceMutation.isPending;

  const handleLaunch = () => {
    const trimmedPrompt = initialPrompt.trim();
    const name = trimmedPrompt
      ? generateWorkspaceNameFromPrompt(trimmedPrompt, existingNames)
      : generateUniqueWorkspaceName(existingNames);
    createWorkspaceMutation.mutate({
      type: 'MANUAL',
      projectId,
      name,
      initialPrompt: trimmedPrompt || undefined,
      ratchetEnabled,
      provider,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Delegate to file mention menu first
    const mentionResult = fileMentions.delegateToFileMentionMenu(e.key);
    if (mentionResult === 'handled') {
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isCreating) {
      e.preventDefault();
      handleLaunch();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setInitialPrompt(newValue);
    fileMentions.detectFileMention(newValue);
    autoResize();
  };

  return (
    <Card className="shrink-0 border-dashed border-primary/50">
      <CardContent className="p-3 space-y-3" onKeyDown={handleKeyDown}>
        <div className="relative">
          <FileMentionPalette
            files={fileMentions.files}
            isOpen={fileMentions.fileMentionMenuOpen}
            isLoading={fileMentions.filesLoading}
            onClose={fileMentions.handleFileMentionMenuClose}
            onSelect={fileMentions.handleFileMentionSelect}
            filter={fileMentions.fileMentionFilter}
            anchorRef={textareaRef as React.RefObject<HTMLElement | null>}
            paletteRef={fileMentions.paletteRef}
          />
          <Textarea
            ref={textareaRef}
            placeholder="What should the agent work on?"
            value={initialPrompt}
            onChange={handleChange}
            rows={3}
            className="resize-none text-sm overflow-hidden"
            autoFocus
            disabled={isCreating}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <RatchetToggleButton
                enabled={ratchetEnabled}
                state="IDLE"
                className="h-5 w-5"
                onToggle={setRatchetEnabled}
                disabled={isLoadingSettings || isCreating}
              />
              <span className="text-xs text-muted-foreground max-[420px]:hidden">Auto-fix</span>
            </div>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as 'CLAUDE' | 'CODEX')}
              disabled={isLoadingSettings || isCreating}
            >
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CLAUDE">Claude</SelectItem>
                <SelectItem value="CODEX">Codex</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 ml-auto">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onCancel}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleLaunch}
              disabled={isCreating || isLoadingSettings}
            >
              {isCreating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Launch
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
