'use client';

import { Brain, ChevronDown, Loader2, Map as MapIcon, Send, Square } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
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
import type { ChatSettings } from '@/lib/claude-types';
import { AVAILABLE_MODELS } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
  // Settings
  settings?: ChatSettings;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
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
  selectedModel: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  // Find the display name for the current model (null = default/first model)
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
        <DropdownMenuRadioGroup
          value={selectedModel ?? AVAILABLE_MODELS[0].value}
          onValueChange={(value) => {
            // If selecting the default (first) model, set to null
            onChange(value === AVAILABLE_MODELS[0].value ? null : value);
          }}
        >
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
            className="h-6 w-6 p-0"
            aria-label="Toggle thinking mode"
          >
            <Brain className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Extended thinking mode</p>
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
            className="h-6 w-6 p-0"
            aria-label="Toggle plan mode"
          >
            <MapIcon className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Plan mode - requires approval before actions</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Chat input component with textarea, send button, and settings controls.
 * Uses InputGroup for a unified bordered container.
 * Supports Enter to send and Shift+Enter for new line.
 */
export function ChatInput({
  onSend,
  onStop,
  disabled = false,
  running = false,
  inputRef,
  placeholder = 'Type a message...',
  className,
  settings,
  onSettingsChange,
}: ChatInputProps) {
  // Handle key press for Enter to send
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter without Shift sends the message
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const text = event.currentTarget.value.trim();
        if (text && !disabled && !running) {
          onSend(text);
          event.currentTarget.value = '';
          // Reset textarea height and overflow
          event.currentTarget.style.height = 'auto';
          event.currentTarget.style.overflowY = 'hidden';
        }
      }
    },
    [onSend, disabled, running]
  );

  // Handle send button click
  const handleSendClick = useCallback(() => {
    if (running) {
      onStop?.();
      return;
    }
    if (inputRef?.current) {
      const text = inputRef.current.value.trim();
      if (text && !disabled) {
        onSend(text);
        inputRef.current.value = '';
        inputRef.current.style.height = 'auto';
        inputRef.current.style.overflowY = 'hidden';
        inputRef.current.focus();
      }
    }
  }, [onSend, onStop, inputRef, disabled, running]);

  // Auto-resize textarea based on content
  const maxHeight = 200;
  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    // Reset height to auto to get accurate scrollHeight
    target.style.height = 'auto';
    const newHeight = Math.min(target.scrollHeight, maxHeight);
    target.style.height = `${newHeight}px`;
    // Show scrollbar only when content exceeds max height
    target.style.overflowY = target.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Focus input when component mounts or when running state changes to false
  useEffect(() => {
    if (!(running || disabled) && inputRef?.current) {
      inputRef.current.focus();
    }
  }, [running, disabled, inputRef]);

  const isDisabled = disabled || !inputRef;

  // Settings change handlers
  const handleModelChange = useCallback(
    (model: string | null) => {
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

  return (
    <div className={cn('px-4 py-3', className)}>
      <InputGroup className="flex-col">
        {/* Text input row */}
        <InputGroupTextarea
          ref={inputRef}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={isDisabled}
          placeholder={isDisabled ? 'Connecting...' : placeholder}
          className={cn(
            'min-h-[40px] max-h-[200px] overflow-y-hidden',
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
              selectedModel={settings?.selectedModel ?? null}
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
          </div>

          {/* Right side: Send/Stop button */}
          {/* Button is enabled when running to allow stop functionality */}
          <InputGroupButton
            onClick={handleSendClick}
            disabled={isDisabled && !running}
            size="icon-sm"
            aria-label={running ? 'Stop' : 'Send message'}
          >
            {running ? (
              <span className="relative flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin absolute" />
                <Square className="h-2 w-2 fill-current" />
              </span>
            ) : (
              <Send className="h-4 w-4" />
            )}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
