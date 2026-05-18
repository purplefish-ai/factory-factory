import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FileMentionPalette } from '@/components/chat/file-mention-palette';
import type { AcpConfigOption } from '@/components/chat/reducer';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import type { ChatSettings, CommandInfo, MessageAttachment, TokenStats } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

import { AttachmentSection, LeftControls, RightControls } from './components/input-controls';
import { useChatInputActions } from './hooks/use-chat-input-actions';
import { useFileMentions } from './hooks/use-file-mentions';
import { usePasteDropHandler } from './hooks/use-paste-drop-handler';
import { useSlashCommands } from './hooks/use-slash-commands';
import { useTextareaResize } from './hooks/use-textarea-resize';

// =============================================================================
// Types
// =============================================================================

export interface ChatInputProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  stopping?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
  // Settings
  settings?: ChatSettings;
  capabilities?: ChatBarCapabilities;
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
  // Called when attachments change
  onAttachmentsChange?: (attachments: MessageAttachment[]) => void;
  // Slash commands for autocomplete
  slashCommands?: CommandInfo[];
  slashCommandsLoaded?: boolean;
  // Token usage stats for context window indicator
  tokenStats?: TokenStats;
  // Workspace ID for file mentions
  workspaceId?: string;
  // ACP config options from agent
  acpConfigOptions?: AcpConfigOption[] | null;
  // Called when user selects an ACP config option value
  onSetConfigOption?: (configId: string, value: string) => void;
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
  onStop,
  disabled = false,
  running = false,
  stopping = false,
  inputRef,
  placeholder = 'Type a message...',
  className,
  settings,
  capabilities,
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
  acpConfigOptions,
  onSetConfigOption,
}: ChatInputProps) {
  // State for file attachments (uncontrolled mode only)
  const [internalAttachments, setInternalAttachments] = useState<MessageAttachment[]>([]);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [modifierHeld, setModifierHeld] = useState(false);
  const fallbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedInputRef = inputRef ?? fallbackInputRef;

  // Use controlled or uncontrolled attachments based on props
  // Controlled mode requires the setter (onAttachmentsChange) - the setter is what makes it controlled
  // If only `attachments` is passed without `onAttachmentsChange`, component is uncontrolled (uses internal state)
  const isControlled = onAttachmentsChange !== undefined;
  const attachments = isControlled ? (controlledAttachments ?? []) : internalAttachments;
  const setAttachments = useCallback(
    (updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])) => {
      if (isControlled) {
        // In controlled mode, always use the external setter
        const currentValue = controlledAttachments ?? [];
        const newValue = typeof updater === 'function' ? updater(currentValue) : updater;
        onAttachmentsChange(newValue);
      } else {
        setInternalAttachments(updater);
      }
    },
    [isControlled, controlledAttachments, onAttachmentsChange]
  );

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
    attachments,
    setAttachments,
    delegateToSlashMenu: slash.delegateToSlashMenu,
    delegateToFileMentionMenu: fileMentions.delegateToFileMentionMenu,
    onCloseFileMentionMenu: fileMentions.handleFileMentionMenuClose,
  });

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setModifierHeld(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setModifierHeld(false);
      }
    };
    const handleBlur = () => setModifierHeld(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const modLabel = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return 'Ctrl';
    }
    const platform = navigator.platform?.toLowerCase() ?? '';
    return platform.includes('mac') ? '⌘' : 'Ctrl';
  }, []);

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
    <div className={cn('px-4 py-3 relative', className)}>
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

      <InputGroup className="flex-col">
        {/* Attachment preview (above text input) */}
        <AttachmentSection attachments={attachments} onRemove={actions.handleRemoveAttachment} />

        {/* Text input row */}
        <InputGroupTextarea
          ref={resolvedInputRef}
          onKeyDown={actions.handleKeyDown}
          onChange={handleInputChange}
          onPaste={pasteDropHandler.handlePaste}
          onDrop={pasteDropHandler.handleDrop}
          onDragOver={pasteDropHandler.handleDragOver}
          onDragLeave={pasteDropHandler.handleDragLeave}
          disabled={isDisabled}
          placeholder={isDisabled ? 'Connecting...' : placeholder}
          className={cn(
            'min-h-[40px] max-h-[110px] overflow-y-auto [field-sizing:content]',
            isDisabled && 'opacity-50 cursor-not-allowed',
            pasteDropHandler.isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
          )}
          rows={1}
        />

        {/* Controls row */}
        <InputGroupAddon
          align="block-end"
          className="flex items-center gap-1 border-t !pt-1 !pb-1"
          data-testid="chat-input-controls"
        >
          {/* Left side: Model selector and toggles */}
          <LeftControls
            settings={settings}
            capabilities={capabilities}
            onModelChange={actions.handleModelChange}
            onReasoningChange={actions.handleReasoningChange}
            onThinkingChange={actions.handleThinkingChange}
            onPlanModeChange={actions.handlePlanModeChange}
            running={running}
            modLabel={modLabel}
            modifierHeld={modifierHeld}
            fileInputRef={actions.fileInputRef}
            onFileSelect={actions.handleFileSelect}
            supportedImageTypes={actions.supportedImageTypes}
            disabled={isDisabled}
            onQuickAction={actions.handleQuickAction}
            quickActionsOpen={quickActionsOpen}
            onQuickActionsOpenChange={setQuickActionsOpen}
            tokenStats={tokenStats}
            acpConfigOptions={acpConfigOptions}
            onSetConfigOption={onSetConfigOption}
          />

          {/* Right side: Sending indicator + Stop button (when running) + Send button */}
          <RightControls
            pendingMessageCount={pendingMessageCount}
            running={running}
            stopping={stopping}
            onStop={onStop}
            onSendClick={actions.handleSendClick}
            disabled={isDisabled}
            inputRef={resolvedInputRef}
          />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
});
