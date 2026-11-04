import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import { ProviderUsageControl } from '@/client/features/chat/usage-stats/provider-usage-control';
import {
  FileMentionPalette,
  SlashCommandPalette,
  usePasteDropHandler,
  useSlashCommands,
} from '@/client/features/composer';
import { useShortcut } from '@/client/features/shortcuts';
import { runInBackground } from '@/client/lib/background-task';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import type { ChatSettings, CommandInfo, MessageAttachment, TokenStats } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { AttachmentSection, LeftControls, RightControls } from './components/input-controls';
import { useChatInputActions } from './hooks/use-chat-input-actions';
import { useFileMentions } from './hooks/use-file-mentions';
import { useTextareaResize } from './hooks/use-textarea-resize';

// =============================================================================
// Types
// =============================================================================

export interface ChatInputProps {
  onSend: (text: string) => void;
  // Sends /compact while preserving the current draft and attachments.
  onCompact?: () => void;
  onStop?: () => void;
  leadingControls?: React.ReactNode;
  disabled?: boolean;
  running?: boolean;
  // Prompt ownership controls queue wording independently of background activity.
  promptInFlight?: boolean;
  stopping?: boolean;
  isCompacting?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
  // Settings
  settings?: ChatSettings;
  capabilities?: ChatBarCapabilities;
  capabilitiesLoaded?: boolean;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
  // Called when textarea height changes (for scroll adjustment)
  onHeightChange?: () => void;
  // Draft input value (for preserving across tab switches)
  value?: string;
  // Called when input value changes
  onChange?: (value: string) => void;
  // Number of messages pending backend confirmation
  pendingMessageCount?: number;
  // Controlled attachments (for recovery on rejection)
  attachments?: MessageAttachment[];
  // Called when attachments change. Functional updaters must be resolved against the
  // owner's latest value (e.g. a React state setter), not a render snapshot.
  onAttachmentsChange?: (attachments: React.SetStateAction<MessageAttachment[]>) => void;
  // Slash commands for autocomplete
  slashCommands?: CommandInfo[];
  slashCommandsLoaded?: boolean;
  // Token usage stats for context window indicator
  tokenStats?: TokenStats;
  // Workspace ID for file mentions
  workspaceId?: string;
  codexAccountId?: string | null;
  // ACP config options from agent
  acpConfigOptions?: AcpConfigOption[] | null;
  // Called when user selects an ACP config option value
  onSetConfigOption?: (configId: string, value: string) => void;
  /** Lets quick actions start a new chat; omit where only this chat applies. */
  onRunQuickActionInNewChat?: (name: string, prompt: string) => void;
  /** Why a new chat can't start right now; shown in the quick actions menu. */
  newChatUnavailableReason?: string | null;
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Chat input component with textarea, send button, and settings controls.
 * Uses InputGroup for a unified bordered container.
 * Supports Enter to send and Shift+Enter for new line.
 * Memoized to prevent unnecessary re-renders from parent state changes.
 */
export const ChatInput = memo(function ChatInput({
  onSend,
  onCompact,
  onStop,
  leadingControls,
  disabled = false,
  running = false,
  promptInFlight = running,
  stopping = false,
  isCompacting = false,
  inputRef,
  placeholder = 'Type a message…',
  className,
  settings,
  capabilities,
  capabilitiesLoaded,
  onSettingsChange,
  onHeightChange,
  value,
  onChange,
  pendingMessageCount = 0,
  attachments: controlledAttachments,
  onAttachmentsChange,
  slashCommands = [],
  slashCommandsLoaded = false,
  tokenStats,
  workspaceId,
  codexAccountId,
  acpConfigOptions,
  onSetConfigOption,
  onRunQuickActionInNewChat,
  newChatUnavailableReason,
}: ChatInputProps) {
  // State for file attachments (uncontrolled mode only)
  const [internalAttachments, setInternalAttachments] = useState<MessageAttachment[]>([]);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const fallbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedInputRef = inputRef ?? fallbackInputRef;

  // Use controlled or uncontrolled attachments based on props
  // Controlled mode requires the setter (onAttachmentsChange) - the setter is what makes it controlled
  // If only `attachments` is passed without `onAttachmentsChange`, component is uncontrolled (uses internal state)
  const isControlled = onAttachmentsChange !== undefined;
  const attachments = isControlled ? (controlledAttachments ?? []) : internalAttachments;
  // Forward updaters unresolved: async paste/drop/upload conversions apply them after
  // later edits, so only the owner of the state can resolve them against its latest value.
  const setAttachments = onAttachmentsChange ?? setInternalAttachments;

  // Slash commands hook
  const slash = useSlashCommands({
    enabled: capabilities?.slashCommands.enabled === true,
    slashCommands,
    commandsLoaded: slashCommandsLoaded,
    inputRef: resolvedInputRef,
    onChange,
  });

  // File mentions hook
  const fileMentions = useFileMentions({
    workspaceId,
    inputRef: resolvedInputRef,
    onChange,
  });

  // Combined input change handler for both slash commands and file mentions
  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      // Call slash command detection
      slash.handleInputChange(event);
      // Call file mention detection
      fileMentions.detectFileMention(newValue);
    },
    [slash, fileMentions]
  );

  // Actions hook
  const actions = useChatInputActions({
    onSend,
    onStop,
    onOpenQuickActions: () => setQuickActionsOpen(true),
    onCloseSlashMenu: slash.handleSlashMenuClose,
    onChange,
    onSettingsChange,
    disabled,
    running,
    stopping,
    settings,
    capabilities,
    acpConfigOptions,
    onSetConfigOption,
    attachments,
    setAttachments,
    delegateToSlashMenu: slash.delegateToSlashMenu,
    delegateToFileMentionMenu: fileMentions.delegateToFileMentionMenu,
    onCloseFileMentionMenu: fileMentions.handleFileMentionMenuClose,
  });

  const { handleFileSelect } = actions;
  const onFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      runInBackground(handleFileSelect(event), "Couldn't attach file.");
    },
    [handleFileSelect]
  );

  // Textarea resize hook
  useTextareaResize({
    textareaRef: resolvedInputRef,
    onHeightChange,
  });

  // Paste and drag-drop handler hook
  const pasteDropHandler = usePasteDropHandler({
    setAttachments,
    disabled,
  });

  // "/" focuses the composer from elsewhere on the page; a hidden composer
  // (another tab is showing) lets the key through.
  useShortcut(
    'chat.focusComposer',
    () => {
      const input = resolvedInputRef.current;
      if (!input || input.disabled || input.getClientRects().length === 0) {
        return false;
      }
      input.focus();
      return true;
    },
    true,
    () => {
      const input = resolvedInputRef.current;
      return Boolean(input && !input.disabled && input.getClientRects().length > 0);
    }
  );

  // Restore input value from draft when component mounts or value prop changes
  // This preserves the draft across tab switches
  const prevValueRef = useRef(value);
  useEffect(() => {
    // Only restore if value has actually changed from what we last synced
    if (resolvedInputRef.current && value !== undefined && value !== prevValueRef.current) {
      resolvedInputRef.current.value = value;
      prevValueRef.current = value;
    }
  }, [value, resolvedInputRef]);

  const isDisabled = disabled;

  return (
    <div className={cn('relative flex min-h-0 flex-col px-4 py-3', className)}>
      {/* Slash command palette */}
      <SlashCommandPalette
        commands={slashCommands}
        isOpen={slash.slashMenuOpen}
        isLoading={!slash.commandsReady}
        onClose={slash.handleSlashMenuClose}
        onSelect={slash.handleSlashCommandSelect}
        filter={slash.slashFilter}
        anchorRef={resolvedInputRef as React.RefObject<HTMLElement | null>}
        paletteRef={slash.paletteRef}
      />

      {/* File mention palette */}
      <FileMentionPalette
        files={fileMentions.files}
        isOpen={fileMentions.fileMentionMenuOpen}
        isLoading={fileMentions.filesLoading}
        onClose={fileMentions.handleFileMentionMenuClose}
        onSelect={fileMentions.handleFileMentionSelect}
        filter={fileMentions.fileMentionFilter}
        anchorRef={resolvedInputRef as React.RefObject<HTMLElement | null>}
        paletteRef={fileMentions.paletteRef}
      />

      <InputGroup className="min-h-0 flex-1 flex-col">
        {/* Attachment preview (above text input) */}
        <AttachmentSection attachments={attachments} onRemove={actions.handleRemoveAttachment} />

        {/* Text input row */}
        <InputGroupTextarea
          ref={resolvedInputRef}
          enterKeyHint="send"
          defaultValue={value}
          onKeyDown={actions.handleKeyDown}
          onChange={handleInputChange}
          onPaste={pasteDropHandler.handlePaste}
          onDrop={pasteDropHandler.handleDrop}
          onDragOver={pasteDropHandler.handleDragOver}
          onDragLeave={pasteDropHandler.handleDragLeave}
          disabled={isDisabled}
          placeholder={isDisabled ? 'Connecting…' : placeholder}
          // Reserve a full line plus py-3 even while an empty field's intrinsic
          // size is recalculated; a transient shrink clamps the transcript above.
          className={cn(
            'min-h-[calc(1lh+1.5rem)] max-h-[min(40dvh,320px)] overflow-y-auto [field-sizing:content]',
            isDisabled && 'opacity-50 cursor-not-allowed',
            pasteDropHandler.isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
          )}
          rows={1}
        />

        {/* Controls row */}
        <InputGroupAddon
          align="block-end"
          className="flex shrink-0 items-center gap-1 border-t !pt-1 !pb-1"
          data-testid="chat-input-controls"
        >
          {leadingControls}
          {/* Left side: Model selector and toggles */}
          <LeftControls
            settings={settings}
            capabilities={capabilities}
            capabilitiesLoaded={capabilitiesLoaded}
            onModelChange={actions.handleModelChange}
            onReasoningChange={actions.handleReasoningChange}
            onThinkingChange={actions.handleThinkingChange}
            onPlanModeChange={actions.handlePlanModeChange}
            running={running}
            stopping={stopping}
            fileInputRef={actions.fileInputRef}
            onFileSelect={onFileSelect}
            supportedImageTypes={actions.supportedImageTypes}
            disabled={isDisabled}
            onQuickAction={actions.handleQuickAction}
            onRunQuickActionInNewChat={onRunQuickActionInNewChat}
            newChatUnavailableReason={newChatUnavailableReason}
            quickActionsOpen={quickActionsOpen}
            onQuickActionsOpenChange={setQuickActionsOpen}
            acpConfigOptions={acpConfigOptions}
            onSetConfigOption={onSetConfigOption}
          />

          {/* Right side: Sending indicator + Stop button (when running) + Send button */}
          <RightControls
            modLabel={modLabel}
            pendingMessageCount={pendingMessageCount}
            running={running}
            promptInFlight={promptInFlight}
            stopping={stopping}
            onStop={onStop}
            onSendClick={actions.handleSendClick}
            disabled={isDisabled}
            inputRef={resolvedInputRef}
          >
            {capabilities?.usageStats.enabled &&
              (capabilities.provider === 'CLAUDE' || capabilities.provider === 'CODEX') && (
                <ProviderUsageControl
                  key={`${capabilities.provider}:${codexAccountId ?? 'native'}`}
                  provider={capabilities.provider}
                  codexAccountId={codexAccountId}
                  tokenStats={tokenStats}
                  busy={running || stopping || pendingMessageCount > 0}
                  compacting={isCompacting}
                  disabled={isDisabled}
                  onCompact={onCompact}
                />
              )}
          </RightControls>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
});
