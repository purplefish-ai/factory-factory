import { Loader2, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { createOptimisticWorkspaceCacheData } from '@/client/lib/workspace-cache-helpers';
import { AttachmentPreview } from '@/components/chat/attachment-preview';
import { collectAttachments } from '@/components/chat/chat-input/hooks/attachment-file-conversion';
import { usePasteDropHandler } from '@/components/chat/chat-input/hooks/use-paste-drop-handler';
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
import type { MessageAttachment } from '@/lib/chat-protocol';
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_TEXT_EXTENSIONS } from '@/lib/image-utils';
import { cn } from '@/lib/utils';
import {
  generateUniqueWorkspaceName,
  generateWorkspaceNameFromPrompt,
} from '@/shared/workspace-words';

interface InlineWorkspaceFormProps {
  projectId: string;
  existingNames?: string[];
  onCancel: () => void;
  onCreated: (workspaceId: string) => void;
}

const ATTACHMENT_ACCEPT_TYPES = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_TEXT_EXTENSIONS].join(',');

export function InlineWorkspaceForm({
  projectId,
  existingNames,
  onCancel,
  onCreated,
}: InlineWorkspaceFormProps) {
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();
  const shouldFetchExistingNames = existingNames === undefined;
  const { data: listedWorkspaces, isLoading: isLoadingWorkspaceList } =
    trpc.workspace.list.useQuery({ projectId }, { enabled: shouldFetchExistingNames });
  const availableWorkspaceNames =
    existingNames ?? listedWorkspaces?.map((workspace) => workspace.name) ?? [];

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const [provider, setProvider] = useState<'CLAUDE' | 'CODEX'>('CLAUDE');
  const [startupModePreset, setStartupModePreset] = useState<'non_interactive' | 'plan'>(
    'non_interactive'
  );

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
    onSuccess: (workspace) => {
      utils.workspace.get.setData({ id: workspace.id }, (old) => {
        if (old) {
          return old;
        }
        return createOptimisticWorkspaceCacheData(workspace);
      });
      utils.workspace.listWithKanbanState.invalidate({ projectId });
      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      onCreated(workspace.id);
    },
    onError: (error) => {
      toast.error(`Failed to create workspace: ${error.message}`);
    },
  });

  const isCreating = createWorkspaceMutation.isPending;

  const pasteDropHandler = usePasteDropHandler({
    setAttachments,
    disabled: isCreating,
  });

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const { attachments: newAttachments, errors } = await collectAttachments(files);
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }

    if (errors.length > 0) {
      const formattedErrors = errors.map(({ fileName, message }) => `${fileName}: ${message}`);
      toast.error(`Could not add ${errors.length} file(s): ${formattedErrors.join('; ')}`);
    }

    event.target.value = '';
  };

  const handleLaunch = () => {
    const trimmedPrompt = initialPrompt.trim();
    const name = trimmedPrompt
      ? generateWorkspaceNameFromPrompt(trimmedPrompt, availableWorkspaceNames)
      : generateUniqueWorkspaceName(availableWorkspaceNames);
    createWorkspaceMutation.mutate({
      type: 'MANUAL',
      projectId,
      name,
      initialPrompt: trimmedPrompt || undefined,
      initialAttachments: attachments.length > 0 ? attachments : undefined,
      startupModePreset: startupModePreset === 'plan' ? 'plan' : undefined,
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

    if (e.key === 'Escape' && !isCreating) {
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
            onPaste={pasteDropHandler.handlePaste}
            onDrop={pasteDropHandler.handleDrop}
            onDragOver={pasteDropHandler.handleDragOver}
            onDragLeave={pasteDropHandler.handleDragLeave}
            rows={3}
            className={cn(
              'resize-none text-sm overflow-hidden',
              pasteDropHandler.isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
            )}
            autoFocus
            disabled={isCreating}
          />
        </div>
        {attachments.length > 0 ? (
          <AttachmentPreview
            attachments={attachments}
            onRemove={(id) =>
              setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
            }
          />
        ) : null}
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
            <Select
              value={startupModePreset}
              onValueChange={(v) => setStartupModePreset(v as 'non_interactive' | 'plan')}
              disabled={isCreating}
            >
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="non_interactive">Default</SelectItem>
                <SelectItem value="plan">Plan</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={isCreating}
            >
              <Paperclip className="h-3.5 w-3.5 mr-1" />
              Attach
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT_TYPES}
              onChange={handleFileSelect}
              className="hidden"
              aria-label="Attach files"
            />
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
              disabled={
                isCreating ||
                isLoadingSettings ||
                (shouldFetchExistingNames && isLoadingWorkspaceList)
              }
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
