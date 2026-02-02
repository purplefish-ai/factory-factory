'use client';

import {
  Brain,
  ChevronDown,
  GitPullRequest,
  ImagePlus,
  Loader2,
  Map as MapIcon,
  MessageSquareText,
  Send,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AttachmentPreview } from '@/components/chat/attachment-preview';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatSettings, CommandInfo, MessageAttachment } from '@/lib/claude-types';
import { AVAILABLE_MODELS } from '@/lib/claude-types';
import { fileToAttachment, SUPPORTED_IMAGE_TYPES } from '@/lib/image-utils';
import { cn } from '@/lib/utils';
import { SlashCommandPalette } from './slash-command-palette';

// =============================================================================
// Types
// =============================================================================

interface ChatInputProps {
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
}

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Model selector dropdown.
 */
function ModelSelector({
  selectedModel,
  onChange,
  disabled,
}: {
  selectedModel: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const currentModel = AVAILABLE_MODELS.find((m) => m.value === selectedModel);
  const displayName = currentModel?.displayName ?? AVAILABLE_MODELS[0].displayName;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {displayName}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuRadioGroup value={selectedModel} onValueChange={onChange}>
          {AVAILABLE_MODELS.map((model) => (
            <DropdownMenuRadioItem key={model.value} value={model.value}>
              {model.displayName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Thinking mode toggle button.
 */
function ThinkingToggle({
  pressed,
  onPressedChange,
  disabled,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            size="sm"
            className={cn(
              'h-6 w-6 p-0',
              pressed &&
                'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
            )}
            aria-label="Toggle thinking mode"
          >
            <Brain className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Extended thinking mode {pressed ? '(on)' : '(off)'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Plan mode toggle button.
 */
function PlanModeToggle({
  pressed,
  onPressedChange,
  disabled,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            size="sm"
            className={cn(
              'h-6 w-6 p-0',
              pressed &&
                'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
            )}
            aria-label="Toggle plan mode"
          >
            <MapIcon className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Plan mode {pressed ? '(on)' : '(off)'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Predefined quick actions that send messages to Claude.
 */
const QUICK_ACTIONS = [
  {
    id: 'create-pr',
    label: 'Create Pull Request',
    icon: GitPullRequest,
    message:
      'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.',
  },
  {
    id: 'address-pr-comments',
    label: 'Address PR Comments',
    icon: MessageSquareText,
    message:
      'Fetch the comments on the current pull request using the GitHub CLI (gh) and address any feedback or requested changes.',
  },
  {
    id: 'simplify-code',
    label: 'Simplify Code',
    icon: Sparkles,
    message:
      'Use the code-simplifier agent to review and simplify the recent changes. Focus on improving clarity, consistency, and maintainability while preserving all functionality.',
  },
] as const;

/**
 * Quick actions dropdown for sending predefined messages.
 */
function QuickActionsDropdown({
  onAction,
  disabled,
}: {
  onAction: (message: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-6 w-6 p-0"
                aria-label="Quick actions"
              >
                <Zap className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Quick actions</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="start" className="w-56">
        {QUICK_ACTIONS.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onClick={() => onAction(action.message)}
            className="gap-2"
          >
            <action.icon className="h-4 w-4" />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  onSettingsChange,
  onHeightChange,
  value,
  onChange,
  pendingMessageCount = 0,
  attachments: controlledAttachments,
  onAttachmentsChange,
  slashCommands = [],
}: ChatInputProps) {
  // State for file attachments (uncontrolled mode only)
  const [internalAttachments, setInternalAttachments] = useState<MessageAttachment[]>([]);

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slash command palette state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');

  // Handle input changes to preserve draft across tab switches and detect slash commands
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      onChange?.(newValue);

      // Detect slash command at start of input
      if (newValue.startsWith('/') && slashCommands.length > 0) {
        // Extract the text after / (before any space)
        const afterSlash = newValue.slice(1);
        const spaceIndex = afterSlash.indexOf(' ');
        const filter = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);

        // Only show menu if no space yet (still completing command name)
        if (spaceIndex === -1) {
          setSlashFilter(filter);
          setSlashMenuOpen(true);
        } else {
          setSlashMenuOpen(false);
        }
      } else {
        setSlashMenuOpen(false);
        setSlashFilter('');
      }
    },
    [onChange, slashCommands.length]
  );

  // Handle file selection
  const handleFileSelect = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: File handling requires multiple checks
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }

      const newAttachments: MessageAttachment[] = [];

      for (const file of Array.from(files)) {
        try {
          const attachment = await fileToAttachment(file);
          newAttachments.push(attachment);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          toast.error(`Failed to upload ${file.name}: ${message}`);
        }
      }

      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments]);
      }

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [setAttachments]
  );

  // Handle removing an attachment
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((att) => att.id !== id));
    },
    [setAttachments]
  );

  // Handle key press for Enter to send
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // If slash menu is open, let the palette handle keyboard events
      // (except for typing which continues to filter)
      if (slashMenuOpen && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) {
        // Don't prevent default here - the SlashCommandPalette handles these via window listener
        return;
      }

      // Enter without Shift sends the message (queues if agent is running)
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const text = event.currentTarget.value.trim();
        if ((text || attachments.length > 0) && !disabled) {
          onSend(text);
          event.currentTarget.value = '';
          onChange?.('');
          setAttachments([]);
        }
      }
    },
    [onSend, disabled, onChange, setAttachments, attachments, slashMenuOpen]
  );

  // Handle send button click
  const handleSendClick = useCallback(() => {
    if (inputRef?.current) {
      const text = inputRef.current.value.trim();
      if ((text || attachments.length > 0) && !disabled) {
        onSend(text);
        inputRef.current.value = '';
        onChange?.('');
        setAttachments([]);
      }
    }
  }, [onSend, inputRef, disabled, onChange, setAttachments, attachments]);

  // Watch for textarea height changes (from field-sizing: content) to notify parent
  // Debounce to avoid excessive scroll calculations during rapid typing
  useEffect(() => {
    const textarea = inputRef?.current;
    if (!(textarea && onHeightChange)) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      // Debounce to reduce scroll thrashing during rapid typing
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        onHeightChange();
      }, 50);
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [inputRef, onHeightChange]);

  // Restore input value from draft when component mounts or value prop changes
  // This preserves the draft across tab switches
  const prevValueRef = useRef(value);
  useEffect(() => {
    // Only restore if value has actually changed from what we last synced
    if (inputRef?.current && value !== undefined && value !== prevValueRef.current) {
      inputRef.current.value = value;
      prevValueRef.current = value;
    }
  }, [value, inputRef]);

  const isDisabled = disabled || !inputRef;

  // Settings change handlers
  const handleModelChange = useCallback(
    (model: string) => {
      onSettingsChange?.({ selectedModel: model });
    },
    [onSettingsChange]
  );

  const handleThinkingChange = useCallback(
    (pressed: boolean) => {
      onSettingsChange?.({ thinkingEnabled: pressed });
    },
    [onSettingsChange]
  );

  const handlePlanModeChange = useCallback(
    (pressed: boolean) => {
      onSettingsChange?.({ planModeEnabled: pressed });
    },
    [onSettingsChange]
  );

  // Handle quick action - sends the predefined message
  const handleQuickAction = useCallback(
    (message: string) => {
      if (!disabled) {
        onSend(message);
      }
    },
    [onSend, disabled]
  );

  // Handle slash command selection
  const handleSlashCommandSelect = useCallback(
    (command: CommandInfo) => {
      // Replace input with /<command-name> followed by a space
      const newValue = `/${command.name} `;
      if (inputRef?.current) {
        inputRef.current.value = newValue;
        inputRef.current.focus();
        // Move cursor to end
        inputRef.current.setSelectionRange(newValue.length, newValue.length);
      }
      onChange?.(newValue);
      setSlashMenuOpen(false);
      setSlashFilter('');
    },
    [inputRef, onChange]
  );

  // Handle closing the slash command palette
  const handleSlashMenuClose = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashFilter('');
  }, []);

  return (
    <div className={cn('px-4 py-3 relative', className)}>
      {/* Slash command palette */}
      <SlashCommandPalette
        commands={slashCommands}
        isOpen={slashMenuOpen}
        onClose={handleSlashMenuClose}
        onSelect={handleSlashCommandSelect}
        filter={slashFilter}
        anchorRef={inputRef as React.RefObject<HTMLElement | null>}
      />

      <InputGroup className="flex-col">
        {/* Attachment preview (above text input) */}
        {attachments.length > 0 && (
          <div className="px-3 pt-2 pb-1">
            <AttachmentPreview attachments={attachments} onRemove={handleRemoveAttachment} />
          </div>
        )}

        {/* Text input row */}
        <InputGroupTextarea
          ref={inputRef}
          onKeyDown={handleKeyDown}
          onChange={handleInputChange}
          disabled={isDisabled}
          placeholder={isDisabled ? 'Connecting...' : placeholder}
          className={cn(
            'min-h-[40px] max-h-[110px] overflow-y-auto [field-sizing:content]',
            isDisabled && 'opacity-50 cursor-not-allowed'
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
              onChange={handleModelChange}
              disabled={running}
            />
            <div className="h-4 w-px bg-border" />
            <ThinkingToggle
              pressed={settings?.thinkingEnabled ?? false}
              onPressedChange={handleThinkingChange}
              disabled={running}
            />
            <PlanModeToggle
              pressed={settings?.planModeEnabled ?? false}
              onPressedChange={handlePlanModeChange}
              disabled={running}
            />
            <div className="h-4 w-px bg-border" />
            {/* File upload button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={running || isDisabled}
                    className="h-6 w-6 p-0"
                    aria-label="Upload image"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Upload image</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <QuickActionsDropdown onAction={handleQuickAction} disabled={isDisabled} />
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept={SUPPORTED_IMAGE_TYPES.join(',')}
              multiple
              onChange={handleFileSelect}
              className="hidden"
              aria-label="File upload input"
            />
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
              onClick={handleSendClick}
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
