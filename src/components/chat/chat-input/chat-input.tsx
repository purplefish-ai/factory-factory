'use client';

import { Brain, ImagePlus, Loader2, Map as MapIcon, Send, Square } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentPreview } from '@/components/chat/attachment-preview';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatSettings, CommandInfo, MessageAttachment, TokenStats } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { ContextWindowIndicator } from '../usage-stats';

import { ModelSelector } from './components/model-selector';
import { QuickActionsDropdown } from './components/quick-actions-dropdown';
import { SettingsToggle } from './components/settings-toggle';
import { useChatInputActions } from './hooks/use-chat-input-actions';
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
  // Token usage stats for context window indicator
  tokenStats?: TokenStats;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: UI composition requires conditional rendering
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
  onSettingsChange,
  onHeightChange,
  value,
  onChange,
  pendingMessageCount = 0,
  attachments: controlledAttachments,
  onAttachmentsChange,
  slashCommands = [],
  tokenStats,
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
    slashCommands,
    inputRef: resolvedInputRef,
    onChange,
  });

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
    attachments,
    setAttachments,
    delegateToSlashMenu: slash.delegateToSlashMenu,
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

      <InputGroup className="flex-col">
        {/* Attachment preview (above text input) */}
        {attachments.length > 0 && (
          <div className="px-3 pt-2 pb-1">
            <AttachmentPreview
              attachments={attachments}
              onRemove={actions.handleRemoveAttachment}
            />
          </div>
        )}

        {/* Text input row */}
        <InputGroupTextarea
          ref={resolvedInputRef}
          onKeyDown={actions.handleKeyDown}
          onChange={slash.handleInputChange}
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
          className="flex items-center justify-between border-t !pt-1 !pb-1"
        >
          {/* Left side: Model selector and toggles */}
          <div className="flex items-center gap-1">
            <ModelSelector
              selectedModel={settings?.selectedModel ?? 'opus'}
              onChange={actions.handleModelChange}
              disabled={running}
            />
            <div className="h-4 w-px bg-border" />
            <SettingsToggle
              pressed={settings?.thinkingEnabled ?? false}
              onPressedChange={actions.handleThinkingChange}
              disabled={running}
              icon={Brain}
              label="Extended thinking mode"
              ariaLabel="Toggle thinking mode"
              shortcut={`${modLabel}+Shift+T`}
              showShortcut={modifierHeld}
            />
            <SettingsToggle
              pressed={settings?.planModeEnabled ?? false}
              onPressedChange={actions.handlePlanModeChange}
              disabled={running}
              icon={MapIcon}
              label="Plan mode"
              ariaLabel="Toggle plan mode"
              shortcut={`${modLabel}+Shift+P`}
              showShortcut={modifierHeld}
            />
            <div className="h-4 w-px bg-border" />
            {/* File upload button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => actions.fileInputRef.current?.click()}
                    disabled={running || isDisabled}
                    className="h-6 w-6 p-0"
                    aria-label="Upload image"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>
                    Upload image
                    {modifierHeld ? ` (${modLabel}+Shift+U)` : ''}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <QuickActionsDropdown
              onAction={actions.handleQuickAction}
              disabled={isDisabled}
              open={quickActionsOpen}
              onOpenChange={setQuickActionsOpen}
              shortcut={`${modLabel}+Shift+A`}
              showShortcut={modifierHeld}
            />
            {/* Hidden file input */}
            <input
              ref={actions.fileInputRef}
              type="file"
              accept={actions.supportedImageTypes.join(',')}
              multiple
              onChange={actions.handleFileSelect}
              className="hidden"
              aria-label="File upload input"
            />
            {/* Context window indicator */}
            {tokenStats && (
              <>
                <div className="h-4 w-px bg-border" />
                <ContextWindowIndicator tokenStats={tokenStats} />
              </>
            )}
          </div>

          {/* Right side: Sending indicator + Stop button (when running) + Send button */}
          <div className="flex items-center gap-1">
            {/* Show sending indicator when messages are pending backend confirmation */}
            {pendingMessageCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Sending...</span>
              </div>
            )}
            {running && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onStop}
                disabled={stopping}
                className="h-7 w-7"
                aria-label={stopping ? 'Stopping...' : 'Stop agent'}
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )}
              </Button>
            )}
            {/* Send button - always enabled (except when disconnected), queues when running */}
            <InputGroupButton
              onClick={() => actions.handleSendClick(inputRef ?? { current: null })}
              disabled={isDisabled}
              size="icon-sm"
              aria-label={running ? 'Queue message' : 'Send message'}
            >
              <Send className="h-4 w-4" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
});
