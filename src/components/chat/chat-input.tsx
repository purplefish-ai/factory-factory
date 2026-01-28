'use client';

import { Brain, ChevronDown, Loader2, Map as MapIcon, Send, Square } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef } from 'react';

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
  stopping?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
  // Settings
  settings?: ChatSettings;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
  // Session tracking for auto-focus on new sessions
  sessionId?: string | null;
  // Called when textarea height changes (for scroll adjustment)
  onHeightChange?: () => void;
  // Draft input value (for preserving across tab switches)
  value?: string;
  // Called when input value changes
  onChange?: (value: string) => void;
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
  stopping = false,
  inputRef,
  placeholder = 'Type a message...',
  className,
  settings,
  onSettingsChange,
  sessionId,
  onHeightChange,
  value,
  onChange,
}: ChatInputProps) {
  // Handle input changes to preserve draft across tab switches
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(event.target.value);
    },
    [onChange]
  );

  // Handle key press for Enter to send
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter without Shift sends the message (queues if agent is running)
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const text = event.currentTarget.value.trim();
        if (text && !disabled) {
          onSend(text);
          event.currentTarget.value = '';
          onChange?.('');
        }
      }
    },
    [onSend, disabled, onChange]
  );

  // Handle send button click
  const handleSendClick = useCallback(() => {
    if (inputRef?.current) {
      const text = inputRef.current.value.trim();
      if (text && !disabled) {
        onSend(text);
        inputRef.current.value = '';
        onChange?.('');
        inputRef.current.focus();
      }
    }
  }, [onSend, inputRef, disabled, onChange]);

  // Watch for textarea height changes (from field-sizing: content) to notify parent
  useEffect(() => {
    const textarea = inputRef?.current;
    if (!(textarea && onHeightChange)) {
      return;
    }

    const observer = new ResizeObserver(() => {
      onHeightChange();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [inputRef, onHeightChange]);

  // Track previous state to only auto-focus on specific transitions
  const prevRunningRef = useRef(running);
  const prevDisabledRef = useRef(disabled);
  const prevSessionIdRef = useRef(sessionId);

  // Focus input only when transitioning from running/disabled to idle, or when session changes
  useEffect(() => {
    const wasRunningOrDisabled = prevRunningRef.current || prevDisabledRef.current;
    const isNowIdle = !(running || disabled);
    const sessionChanged = prevSessionIdRef.current !== sessionId;

    // Update refs for next render
    prevRunningRef.current = running;
    prevDisabledRef.current = disabled;
    prevSessionIdRef.current = sessionId;

    // Only focus when transitioning to idle state OR when session changes
    if (inputRef?.current && isNowIdle && (wasRunningOrDisabled || sessionChanged)) {
      inputRef.current.focus();
    }
  }, [running, disabled, inputRef, sessionId]);

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

          {/* Right side: Stop button (when running) + Send button */}
          <div className="flex items-center gap-1">
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
}
