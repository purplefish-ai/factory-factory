import { useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useId, useLayoutEffect, useRef } from 'react';
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
  useFileMentions,
  usePasteDropHandler,
  useSlashCommands,
} from '@/client/features/composer';
import { invalidateAgentProjectQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { setPendingWorkspace } from '@/client/lib/pending-workspace';
import type { AppRouter } from '@/client/lib/trpc';
import { trpc } from '@/client/lib/trpc';
import { useUserSettings } from '@/client/lib/user-settings-queries';
import {
  seedCreatedWorkspaceDetail,
  removeWorkspaceFromProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-helpers';
import { setProjectWorkspaceList } from '@/client/lib/workspace-queries';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_TEXT_EXTENSIONS } from '@/lib/image-utils';
import { cn } from '@/lib/utils';
import {
  generateUniqueWorkspaceName,
  generateWorkspaceNameFromPrompt,
} from '@/shared/workspace-words';
import { useInlineWorkspaceDraft } from './use-inline-workspace-draft';
import {
  useWorkspaceCreationSubmission,
  type WorkspaceCreationSubmission,
} from './use-workspace-creation-submission';
import { WorkspaceCreationOptions } from './workspace-creation-options';
import { WorkspaceLaunchButton } from './workspace-launch-button';

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
  toast.error(reason ?? "Couldn't create workspace. Creation is not ready.");
}

interface InlineWorkspaceFormProps {
  projectId: string;
  /** Separate event-authoring draft; always launches an ordinary workspace. */
  purpose?: 'event-agent';
  /** Names already taken in this project, used to generate a unique one. */
  existingNames: string[];
  onCancel: () => void;
  onCreated: (workspaceId: string) => void;
  /** Select the local launch immediately, before server preflight completes. */
  onLaunching?: (workspaceId: string) => void;
}

const ATTACHMENT_ACCEPT_TYPES = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_TEXT_EXTENSIONS].join(',');

async function processFileInput(event: React.ChangeEvent<HTMLInputElement>) {
  const files = event.target.files;
  if (!files || files.length === 0) {
    return null;
  }
  const { attachments: newAttachments, errors } = await collectAttachments({
    mode: 'images-and-text',
    files,
  });
  if (errors.length > 0) {
    const formattedErrors = errors.map(({ fileName, message }) => `${fileName}: ${message}`);
    toast.error(
      `Couldn't add ${errors.length} ${errors.length === 1 ? 'file' : 'files'}. ${formattedErrors.join('; ')}`
    );
  }
  event.target.value = '';
  return { newAttachments };
}

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProjectWorkspaceCache = RouterOutputs['workspace']['listForProject'];

interface CreateWorkspaceMutationContext {
  optimisticWorkspaceId: string;
  submission: WorkspaceCreationSubmission | null;
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
      <p className="text-2xs text-muted-foreground">
        Creates a new workspace on this schedule. The first run starts immediately.
        {isLongCadence && scheduledTime ? ' Subsequent runs will use the time above.' : ''}
      </p>
    </div>
  );
}

function workspaceDraftContext(projectId: string, purpose?: 'event-agent') {
  return {
    draftId: purpose ? `event-agent:${projectId}` : projectId,
    seedPrompt: purpose
      ? 'Help me create an event-triggered automation for this project. Ask which event should trigger it and what it should do. Use list_automation_sources to discover available sources, then propose_automation to prepare a configuration for my review. Keep the definition and triggers paused; do not enable listening or automatic runs.'
      : '',
  };
}

export function InlineWorkspaceForm({
  projectId,
  purpose,
  existingNames,
  onCancel,
  onCreated,
  onLaunching,
}: InlineWorkspaceFormProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { data: userSettings, isLoading: isLoadingSettings } = useUserSettings();

  const instructionsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { draftId, seedPrompt } = workspaceDraftContext(projectId, purpose);
  const recovery = useInlineWorkspaceDraft(
    projectId,
    userSettings?.ratchetEnabled,
    draftId,
    seedPrompt
  );
  const {
    draft,
    launchSelection,
    ratchetEnabled,
    setInitialPrompt,
    setAttachments,
    setRatchetEnabled,
    setMode,
    setCadence,
    setScheduledTime,
  } = recovery;
  const { prompt: initialPrompt, attachments, cadence, scheduledTime } = draft;
  const mode = purpose === 'event-agent' ? 'STANDARD' : draft.mode;
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (
      !textarea ||
      textarea.value !== initialPrompt ||
      typeof CSS === 'undefined' ||
      CSS.supports('field-sizing', 'content')
    ) {
      return;
    }
    // Older browsers need manual sizing. Preserve the scroll that measuring at
    // auto height clamps, and resize only once after the draft is committed.
    const top = textarea.scrollTop;
    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + borderHeight, 240)}px`;
    textarea.scrollTop = top;
  }, [initialPrompt]);
  // autoFocus does nothing while the saved draft restores, because the field is
  // disabled until then (the first open after a page load). Take focus once it
  // is editable, unless focus has moved to something outside the form's area.
  const focusAfterRestore = useRef(recovery.isRestoring);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!(focusAfterRestore.current && textarea) || recovery.isRestoring) {
      return;
    }
    focusAfterRestore.current = false;
    const active = textarea.ownerDocument.activeElement;
    if (!active || active === textarea.ownerDocument.body || active.contains(textarea)) {
      textarea.focus();
    }
  }, [recovery.isRestoring]);
  const submission = useWorkspaceCreationSubmission(draftId);
  const submitted = useRef<WorkspaceCreationSubmission | null>(null);
  // Mutation callbacks outlive the form; a failure after it closes needs a toast.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const completeCreation = (
    token: WorkspaceCreationSubmission | null | undefined,
    onComplete: () => void
  ) => {
    if (!token) {
      onComplete();
      return;
    }
    runInBackground(
      submission.succeed(token).then((mayClose) => {
        if (mayClose) {
          onComplete();
        }
      }),
      "Couldn't finalize task creation."
    );
  };

  const fileMentions = useFileMentions({
    fileQuery: trpc.project.listAllFiles,
    scope: { projectId },
    scopeReady: !!projectId,
    inputRef: textareaRef,
    onChange: setInitialPrompt,
  });

  const { data: slashCommandsData, isFetched: slashCommandsFetched } =
    trpc.project.listSlashCommands.useQuery({ projectId }, { staleTime: 60_000 });
  const projectCommands = slashCommandsData?.commands ?? [];

  const slashCommands = useSlashCommands({
    enabled: true,
    slashCommands: projectCommands,
    commandsLoaded: slashCommandsFetched,
    inputRef: textareaRef,
    onChange: setInitialPrompt,
  });

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onMutate: async (input): Promise<CreateWorkspaceMutationContext> => {
      const token = submitted.current;
      const optimisticWorkspaceId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticWorkspace = createOptimisticWorkspaceSummary({
        id: optimisticWorkspaceId,
        projectId: input.projectId,
        name: input.type === 'MANUAL' ? input.name : 'New workspace',
        ratchetEnabled: input.type === 'MANUAL' ? (input.ratchetEnabled ?? true) : true,
      });

      setPendingWorkspace(optimisticWorkspaceId, {
        status: 'creating',
        name: optimisticWorkspace.name,
      });
      onLaunching?.(optimisticWorkspaceId);

      await utils.workspace.listForProject.cancel({ projectId: input.projectId });

      setProjectWorkspaceList(queryClient, input.projectId, (old) =>
        withOptimisticWorkspaceFirst(old, optimisticWorkspace, [optimisticWorkspaceId])
      );

      return { optimisticWorkspaceId, submission: token };
    },
    onSuccess: (workspace, _input, context) => {
      const optimisticWorkspace = createOptimisticWorkspaceSummary({
        id: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        ratchetEnabled: workspace.ratchetEnabled,
        createdAt: workspace.createdAt,
      });

      setProjectWorkspaceList(queryClient, workspace.projectId, (old) =>
        withOptimisticWorkspaceFirst(
          old,
          old?.workspaces.find((row) => row.id === workspace.id) ?? optimisticWorkspace,
          [workspace.id, ...(context?.optimisticWorkspaceId ? [context.optimisticWorkspaceId] : [])]
        )
      );

      seedCreatedWorkspaceDetail(queryClient, workspace);
      if (context?.optimisticWorkspaceId) {
        setPendingWorkspace(context.optimisticWorkspaceId, {
          status: 'created',
          workspaceId: workspace.id,
        });
      }
      runInBackground(
        utils.workspace.listForProject.invalidate({ projectId: workspace.projectId })
      );
      completeCreation(context?.submission ?? submitted.current, () => {
        // The selected pending route owns navigation after an immediate launch.
        // Never pull the user back if they navigated elsewhere during creation.
        if (!onLaunching) {
          onCreated(workspace.id);
        }
      });
    },
    onError: (error, input, context) => {
      const message = `Couldn't create workspace. ${error.message}`;
      const token = context?.submission ?? submitted.current;
      // One channel per failure: the composer's inline error (kept per project
      // while it is unmounted) and the pending workspace route both show it.
      // Only a create without a submission falls back to a toast.
      if (token) {
        submission.fail(token, message);
      } else {
        toast.error(message);
      }
      if (context) {
        setPendingWorkspace(context.optimisticWorkspaceId, { status: 'failed', message });
        // Drop only the optimistic row. Restoring the pre-mutation cache would
        // also revert snapshot deltas and concurrent mutations that landed
        // while the create was in flight, and this cache backs the sidebar as
        // well as the board.
        setProjectWorkspaceList(
          queryClient,
          input?.projectId ?? token?.projectId ?? projectId,
          (old) => removeWorkspaceFromProjectWorkspaceCache(old, context.optimisticWorkspaceId)
        );
      }
    },
  });

  const createPeriodicTaskMutation = trpc.periodicTask.create.useMutation({
    onMutate: () => ({ submission: submitted.current }),
    onSuccess: (task, _input, context) => {
      toast.success(`Automation "${task.name}" created`);
      runInBackground(invalidateAgentProjectQueries(utils, task.projectId));
      completeCreation(context?.submission ?? submitted.current, onCancel);
    },
    onError: (error, _input, context) => {
      const message = `Couldn't create automation. ${error.message}`;
      const token = context?.submission ?? submitted.current;
      // The open form shows the failure inline; once it has closed (the user
      // navigated away), a toast reports it instead.
      if (token) {
        submission.fail(token, message);
      }
      if (!(token && mounted.current)) {
        toast.error(message);
      }
    },
  });

  const isCreating =
    submission.isPending ||
    createWorkspaceMutation.isPending ||
    createPeriodicTaskMutation.isPending;
  const isBusy = isCreating || recovery.isRestoring;
  const supportsWorkspaceOptions = mode !== 'PERIODIC_TASK';
  const isLaunchDisabled = isBusy || (supportsWorkspaceOptions && !launchSelection.ready);

  const launchDisabledReason = getLaunchDisabledReason(
    recovery.isRestoring,
    supportsWorkspaceOptions,
    launchSelection.unavailableReason
  );

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
      toast.error('Automation requires instructions.');
      return;
    }
    const token = submission.begin();
    if (!token) {
      return;
    }
    submitted.current = token;
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
    const token = submission.begin();
    if (!token) {
      return;
    }
    submitted.current = token;
    const name = trimmedPrompt
      ? generateWorkspaceNameFromPrompt(trimmedPrompt, existingNames)
      : generateUniqueWorkspaceName(existingNames);
    createWorkspaceMutation.mutate({
      type: 'MANUAL',
      projectId,
      name,
      initialPrompt: trimmedPrompt || undefined,
      nameIsGenerated: Boolean(trimmedPrompt),
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
  };

  return (
    <Card
      // The setup card owns progress; retain the composer for failure recovery.
      hidden={isStandardLaunchPending(isCreating, mode)}
      className="shrink-0 border-dashed border-primary/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150 motion-safe:ease-out"
    >
      <CardContent className="p-2 space-y-2" onKeyDown={handleKeyDown}>
        <DraftPersistenceWarning
          message={recovery.persistenceError}
          hasUnreadableDraft={recovery.hasUnreadableDraft}
          onReset={() => {
            void recovery.discardDraft().catch(() => undefined);
          }}
          disabled={isBusy}
        />
        {submission.error && (
          <p role="alert" className="text-xs text-destructive">
            {submission.error}
          </p>
        )}
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
            error={fileMentions.filesError}
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
            rows={2}
            className={cn(
              'min-h-16 max-h-[240px] overflow-y-auto resize-none text-sm focus-visible:ring-1',
              pasteDropHandler.isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
            )}
            autoFocus
            disabled={isBusy}
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
            isCreating={isBusy}
          />
        )}
        {supportsWorkspaceOptions && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT_TYPES}
            onChange={(event) => {
              runInBackground(handleFileSelect(event), "Couldn't attach file.");
            }}
            className="hidden"
            aria-label="Attach files"
          />
        )}
        <WorkspaceCreationOptions
          selection={launchSelection.controlsProps}
          enabled={supportsWorkspaceOptions}
          disabled={isBusy}
          settingsLoading={isLoadingSettings}
          ratchetEnabled={ratchetEnabled}
          onRatchetChange={setRatchetEnabled}
          onAttach={() => fileInputRef.current?.click()}
        >
          <Button
            variant="ghost"
            size="compact"
            className="whitespace-nowrap"
            onClick={() => {
              runInBackground(recovery.discardDraft(), "Couldn't clear canceled task.");
              onCancel();
            }}
            disabled={isBusy}
          >
            Cancel
          </Button>
          <WorkspaceLaunchButton
            mode={mode}
            purpose={purpose}
            isCreating={isCreating}
            isBusy={isBusy}
            disabled={isLaunchDisabled}
            reason={launchDisabledReason}
            onLaunch={() => handleLaunch(mode)}
            onModeChange={setMode}
          />
        </WorkspaceCreationOptions>
      </CardContent>
    </Card>
  );
}

function isStandardLaunchPending(isCreating: boolean, mode: 'STANDARD' | 'PERIODIC_TASK') {
  return isCreating && mode === 'STANDARD';
}

function getLaunchDisabledReason(restoring: boolean, workspaceOptions: boolean, reason?: string) {
  return restoring ? 'Restoring draft' : workspaceOptions ? reason : undefined;
}

function DraftPersistenceWarning({
  message,
  hasUnreadableDraft,
  onReset,
  disabled,
}: {
  message: string | null;
  hasUnreadableDraft: boolean;
  onReset: () => void;
  disabled: boolean;
}) {
  return message ? (
    <div role="alert" className="space-y-1 text-xs text-destructive">
      <p>{message}</p>
      {hasUnreadableDraft && (
        <Button variant="outline" size="sm" onClick={onReset} disabled={disabled}>
          Reset saved draft
        </Button>
      )}
    </div>
  ) : null;
}
