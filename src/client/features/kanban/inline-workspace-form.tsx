import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AgentScheduleFields,
  resolveAgentSchedule,
  supportsAgentClockTime,
} from '@/client/features/agents';
import {
  AttachmentPreview,
  collectAttachments,
  FileMentionPalette,
  SlashCommandPalette,
  usePasteDropHandler,
  useProjectFileMentions,
  useSlashCommands,
} from '@/client/features/composer';
import { useSessionLaunchSelection } from '@/client/features/session-selection';
import { runInBackground } from '@/client/lib/background-task';
import type { AppRouter } from '@/client/lib/trpc';
import { trpc } from '@/client/lib/trpc';
import {
  seedCreatedWorkspaceDetail,
  removeWorkspaceFromProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-helpers';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_TEXT_EXTENSIONS } from '@/lib/image-utils';
import { cn } from '@/lib/utils';
import {
  generateUniqueWorkspaceName,
  generateWorkspaceNameFromPrompt,
} from '@/shared/workspace-words';
import { WorkspaceCreationOptions } from './workspace-creation-options';

function handleFormKeyDown(
  e: React.KeyboardEvent,
  opts: {
    delegateToSlashMenu: (key: string) => string;
    delegateToFileMentionMenu: (key: string) => string;
    isCreating: boolean;
    onCancel: () => void;
    onLaunch: () => void;
  }
) {
  if (opts.delegateToSlashMenu(e.key) === 'handled') {
    e.preventDefault();
    return;
  }
  if (opts.delegateToFileMentionMenu(e.key) === 'handled') {
    e.preventDefault();
    return;
  }
  if (!opts.isCreating) {
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      opts.onLaunch();
    }
  }
}

function reportUnavailableLaunch(reason?: string) {
  toast.error(reason ?? 'Workspace creation is not ready');
}

interface InlineWorkspaceFormProps {
  projectId: string;
  /** Names already taken in this project, used to generate a unique one. */
  existingNames: string[];
  onCancel: () => void;
  onCreated: (workspaceId: string) => void;
}

const ATTACHMENT_ACCEPT_TYPES = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_TEXT_EXTENSIONS].join(',');
const MAX_PROMPT_TEXTAREA_HEIGHT_PX = 240;

async function processFileInput(event: React.ChangeEvent<HTMLInputElement>) {
  const files = event.target.files;
  if (!files || files.length === 0) {
    return null;
  }
  const { attachments: newAttachments, errors } = await collectAttachments(files);
  if (errors.length > 0) {
    const formattedErrors = errors.map(({ fileName, message }) => `${fileName}: ${message}`);
    toast.error(`Could not add ${errors.length} file(s): ${formattedErrors.join('; ')}`);
  }
  event.target.value = '';
  return { newAttachments };
}

const launchButtonLabels: Record<string, string> = {
  STANDARD: 'Launch',
  PERIODIC_TASK: 'Create Agent',
};

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProjectWorkspaceCache = RouterOutputs['workspace']['listForProject'];

interface CreateWorkspaceMutationContext {
  optimisticWorkspaceId: string;
}

/** Put an optimistic row at the head of the shared project list. */
function withOptimisticWorkspaceFirst(
  cache: ProjectWorkspaceCache | undefined,
  optimisticWorkspace: ProjectWorkspaceCache['workspaces'][number],
  replacedIds: string[]
): ProjectWorkspaceCache {
  const withoutReplaced = (cache?.workspaces ?? []).filter(
    (workspace) => !replacedIds.includes(workspace.id)
  );
  return {
    workspaces: [optimisticWorkspace, ...withoutReplaced],
    reviewCount: cache?.reviewCount ?? 0,
  };
}

function PeriodicTaskConfigPanel({
  cadence,
  setCadence,
  scheduledTime,
  setScheduledTime,
  isCreating,
}: {
  cadence: 'EVERY_MINUTE' | 'EVERY_FIVE_MINUTES' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  setCadence: (v: 'EVERY_MINUTE' | 'EVERY_FIVE_MINUTES' | 'DAILY' | 'WEEKLY' | 'MONTHLY') => void;
  scheduledTime: string;
  setScheduledTime: (v: string) => void;
  isCreating: boolean;
}) {
  const isLongCadence = supportsAgentClockTime(cadence);
  return (
    <div className="space-y-2 rounded-md border border-dashed border-primary/40 bg-primary/5 p-3">
      <AgentScheduleFields
        cadence={cadence}
        scheduledTime={scheduledTime}
        onCadenceChange={setCadence}
        onScheduledTimeChange={setScheduledTime}
        disabled={isCreating}
      />
      <p className="text-[10px] text-muted-foreground">
        Creates a new workspace on this schedule. The first run starts immediately.
        {isLongCadence && scheduledTime ? ' Subsequent runs will use the time above.' : ''}
      </p>
    </div>
  );
}

export function InlineWorkspaceForm({
  projectId,
  existingNames,
  onCancel,
  onCreated,
}: InlineWorkspaceFormProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();

  const instructionsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const launchSelection = useSessionLaunchSelection(projectId);
  const [mode, setMode] = useState<'STANDARD' | 'PERIODIC_TASK'>('STANDARD');
  const [cadence, setCadence] = useState<
    'EVERY_MINUTE' | 'EVERY_FIVE_MINUTES' | 'DAILY' | 'WEEKLY' | 'MONTHLY'
  >('DAILY');
  const [scheduledTime, setScheduledTime] = useState('');

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      const fullHeight = el.scrollHeight;
      const clampedHeight = Math.min(fullHeight, MAX_PROMPT_TEXTAREA_HEIGHT_PX);
      el.style.height = `${clampedHeight}px`;
      el.style.overflowY = fullHeight > MAX_PROMPT_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden';
    }
  }, []);

  const onPromptChange = useCallback(
    (value: string) => {
      setInitialPrompt(value);
      autoResize();
    },
    [autoResize]
  );

  const fileMentions = useProjectFileMentions({
    projectId,
    inputRef: textareaRef,
    onChange: onPromptChange,
  });

  const { data: slashCommandsData, isFetched: slashCommandsFetched } =
    trpc.project.listSlashCommands.useQuery({ projectId }, { staleTime: 60_000 });
  const projectCommands = slashCommandsData?.commands ?? [];

  const slashCommands = useSlashCommands({
    enabled: true,
    slashCommands: projectCommands,
    commandsLoaded: slashCommandsFetched,
    inputRef: textareaRef,
    onChange: onPromptChange,
  });

  // Initialize defaults from user settings once loaded
  useEffect(() => {
    if (!userSettings) {
      return;
    }
    setRatchetEnabled(userSettings.ratchetEnabled);
  }, [userSettings]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onMutate: async (input): Promise<CreateWorkspaceMutationContext> => {
      const optimisticWorkspaceId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticWorkspace = createOptimisticWorkspaceSummary({
        id: optimisticWorkspaceId,
        projectId,
        name: input.type === 'MANUAL' ? input.name : 'New Workspace',
        ratchetEnabled: input.type === 'MANUAL' ? (input.ratchetEnabled ?? true) : true,
      });

      await utils.workspace.listForProject.cancel({ projectId });

      utils.workspace.listForProject.setData({ projectId }, (old) =>
        withOptimisticWorkspaceFirst(old, optimisticWorkspace, [optimisticWorkspaceId])
      );

      return { optimisticWorkspaceId };
    },
    onSuccess: (workspace, _input, context) => {
      const optimisticWorkspace = createOptimisticWorkspaceSummary({
        id: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        ratchetEnabled: workspace.ratchetEnabled,
        createdAt: workspace.createdAt,
      });

      utils.workspace.listForProject.setData({ projectId }, (old) =>
        withOptimisticWorkspaceFirst(old, optimisticWorkspace, [
          workspace.id,
          ...(context?.optimisticWorkspaceId ? [context.optimisticWorkspaceId] : []),
        ])
      );

      seedCreatedWorkspaceDetail(queryClient, workspace);
      runInBackground(
        utils.workspace.listForProject.invalidate({ projectId }),
        'Could not refresh data'
      );
      onCreated(workspace.id);
    },
    onError: (error, _input, context) => {
      if (context) {
        // Drop only the optimistic row. Restoring the pre-mutation cache would
        // also revert snapshot deltas and concurrent mutations that landed
        // while the create was in flight, and this cache backs the sidebar as
        // well as the board.
        utils.workspace.listForProject.setData({ projectId }, (old) =>
          removeWorkspaceFromProjectWorkspaceCache(old, context.optimisticWorkspaceId)
        );
      }
      toast.error(`Failed to create workspace: ${error.message}`);
    },
  });

  const createPeriodicTaskMutation = trpc.periodicTask.create.useMutation({
    onSuccess: (task) => {
      toast.success(`Agent "${task.name}" created`);
      runInBackground(utils.periodicTask.list.invalidate({ projectId }), 'Could not refresh data');
      onCancel();
    },
    onError: (error) => {
      toast.error(`Failed to create agent: ${error.message}`);
    },
  });

  const isCreating = createWorkspaceMutation.isPending || createPeriodicTaskMutation.isPending;
  const supportsWorkspaceOptions = mode !== 'PERIODIC_TASK';
  const isLaunchDisabled = isCreating || (supportsWorkspaceOptions && !launchSelection.ready);

  const launchDisabledReason = supportsWorkspaceOptions
    ? launchSelection.unavailableReason
    : undefined;

  const pasteDropHandler = usePasteDropHandler({
    setAttachments,
    disabled: isCreating || !supportsWorkspaceOptions,
  });

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!supportsWorkspaceOptions) {
      event.target.value = '';
      return;
    }
    const result = await processFileInput(event);
    const newFiles = result?.newAttachments ?? [];
    if (newFiles.length > 0) {
      setAttachments((prev) => [...prev, ...newFiles]);
    }
  };

  const launchPeriodicTask = (trimmedPrompt: string) => {
    if (!trimmedPrompt) {
      toast.error('Agent requires instructions.');
      return;
    }
    const name = generateWorkspaceNameFromPrompt(trimmedPrompt, existingNames);
    createPeriodicTaskMutation.mutate({
      projectId,
      name,
      prompt: trimmedPrompt,
      cadence,
      ...resolveAgentSchedule({ cadence, scheduledTime }),
    });
  };

  const launchWorkspace = (trimmedPrompt: string) => {
    const name = trimmedPrompt
      ? generateWorkspaceNameFromPrompt(trimmedPrompt, existingNames)
      : generateUniqueWorkspaceName(existingNames);
    createWorkspaceMutation.mutate({
      type: 'MANUAL',
      projectId,
      name,
      initialPrompt: trimmedPrompt || undefined,
      initialAttachments: attachments.length > 0 ? attachments : undefined,
      ratchetEnabled,
      ...launchSelection.creationDefaults,
    });
  };

  const handleLaunch = (launchMode: 'STANDARD' | 'PERIODIC_TASK' = mode) => {
    if (isLaunchDisabled) {
      reportUnavailableLaunch(launchDisabledReason);
      return;
    }
    const trimmedPrompt = initialPrompt.trim();
    if (launchMode === 'PERIODIC_TASK') {
      launchPeriodicTask(trimmedPrompt);
    } else {
      launchWorkspace(trimmedPrompt);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) =>
    handleFormKeyDown(e, {
      delegateToSlashMenu: slashCommands.delegateToSlashMenu,
      delegateToFileMentionMenu: fileMentions.delegateToFileMentionMenu,
      isCreating,
      onCancel,
      onLaunch: () => handleLaunch(mode),
    });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    slashCommands.handleInputChange(e);
    fileMentions.detectFileMention(e.target.value);
    autoResize();
  };

  return (
    <Card className="shrink-0 border-dashed border-primary/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150 motion-safe:ease-out">
      <CardContent className="p-3 space-y-3" onKeyDown={handleKeyDown}>
        {mode === 'PERIODIC_TASK' && <Label htmlFor={instructionsId}>Instructions</Label>}
        <div className="relative">
          <SlashCommandPalette
            commands={projectCommands}
            isOpen={slashCommands.slashMenuOpen}
            isLoading={!slashCommands.commandsReady}
            onClose={slashCommands.handleSlashMenuClose}
            onSelect={slashCommands.handleSlashCommandSelect}
            filter={slashCommands.slashFilter}
            anchorRef={textareaRef as React.RefObject<HTMLElement | null>}
            paletteRef={slashCommands.paletteRef}
            placement="below"
          />
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
            id={instructionsId}
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
              'resize-none text-sm',
              pasteDropHandler.isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
            )}
            autoFocus
            disabled={isCreating}
          />
        </div>
        {supportsWorkspaceOptions && attachments.length > 0 ? (
          <AttachmentPreview
            attachments={attachments}
            onRemove={(id) =>
              setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
            }
          />
        ) : null}
        {mode === 'PERIODIC_TASK' && (
          <PeriodicTaskConfigPanel
            cadence={cadence}
            setCadence={setCadence}
            scheduledTime={scheduledTime}
            setScheduledTime={setScheduledTime}
            isCreating={isCreating}
          />
        )}
        {supportsWorkspaceOptions && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT_TYPES}
            onChange={(event) => {
              runInBackground(handleFileSelect(event), 'Could not attach file');
            }}
            className="hidden"
            aria-label="Attach files"
          />
        )}
        <WorkspaceCreationOptions
          selection={launchSelection.controlsProps}
          enabled={supportsWorkspaceOptions}
          disabled={isCreating}
          settingsLoading={isLoadingSettings}
          ratchetEnabled={ratchetEnabled}
          onRatchetChange={setRatchetEnabled}
          onAttach={() => fileInputRef.current?.click()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs whitespace-nowrap"
            onClick={onCancel}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <div className="flex min-w-0">
            <Button
              size="sm"
              className={cn(
                'h-7 min-w-0 shrink text-xs whitespace-nowrap rounded-r-none',
                mode !== 'STANDARD' && 'bg-primary/90'
              )}
              onClick={() => handleLaunch(mode)}
              disabled={isLaunchDisabled}
              title={launchDisabledReason}
              aria-description={launchDisabledReason}
            >
              {isCreating ? <SpinnerGapIcon className="h-3 w-3 animate-spin mr-1" /> : null}
              <span className="truncate">{launchButtonLabels[mode]}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  disabled={isCreating}
                  aria-label="Choose launch mode"
                >
                  <CaretDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-xs">
                <DropdownMenuItem className="text-xs" onClick={() => setMode('STANDARD')}>
                  Launch as Standard Workspace
                </DropdownMenuItem>
                <DropdownMenuItem className="text-xs" onClick={() => setMode('PERIODIC_TASK')}>
                  <RobotIcon className="mr-1.5 h-3 w-3" />
                  Create Agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </WorkspaceCreationOptions>
      </CardContent>
    </Card>
  );
}
