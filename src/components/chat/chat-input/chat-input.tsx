import { Brain, ImagePlus, Loader2, Map as MapIcon, Send, Square } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentPreview } from '@/components/chat/attachment-preview';
import { FileMentionPalette } from '@/components/chat/file-mention-palette';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { ContextWindowIndicator } from '@/components/chat/usage-stats';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatSettings, CommandInfo, MessageAttachment, TokenStats } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

import { ModelSelector } from './components/model-selector';
import { QuickActionsDropdown } from './components/quick-actions-dropdown';
import { SettingsToggle } from './components/settings-toggle';
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
}

// =============================================================================
// Subcomponents
// =============================================================================

/**
 * Renders the attachment preview section above the text input.
 */
const AttachmentSection = memo(function AttachmentSection({
  attachments,
  onRemove,
}: {
  attachments: MessageAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="px-3 pt-2 pb-1">
      <AttachmentPreview attachments={attachments} onRemove={onRemove} />
    </div>
  );
});

/**
 * Renders the file upload button with tooltip.
 */
const FileUploadButton = memo(function FileUploadButton({
  fileInputRef,
  onFileSelect,
  supportedImageTypes,
  running,
  disabled,
  modLabel,
  modifierHeld,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  running: boolean;
  disabled: boolean;
  modLabel: string;
  modifierHeld: boolean;
}) {
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={running || disabled}
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
      <input
        ref={fileInputRef}
        type="file"
        accept={supportedImageTypes.join(',')}
        multiple
        onChange={onFileSelect}
        className="hidden"
        aria-label="File upload input"
      />
    </>
  );
});

interface LeftControlsVisibility {
  provider: ChatBarCapabilities['provider'] | null;
  selectedModel: string;
  selectedReasoningEffort: string;
  showModelSelector: boolean;
  showReasoningSelector: boolean;
  showThinkingToggle: boolean;
  showPlanToggle: boolean;
  showAttachments: boolean;
  showUsageIndicator: boolean;
}

function deriveLeftControlsVisibility(
  settings: ChatSettings | undefined,
  capabilities: ChatBarCapabilities | undefined,
  tokenStats: TokenStats | undefined
): LeftControlsVisibility {
  const showModelSelector =
    capabilities?.model.enabled === true && (capabilities.model.options.length ?? 0) > 0;
  const showReasoningSelector =
    capabilities?.reasoning.enabled === true && (capabilities.reasoning.options.length ?? 0) > 0;
  const showThinkingToggle = capabilities?.thinking.enabled === true;
  const showPlanToggle = capabilities?.planMode.enabled === true;
  const showAttachments =
    capabilities?.attachments.enabled === true && capabilities.attachments.kinds.includes('image');
  const showUsageIndicator =
    capabilities?.usageStats.enabled === true &&
    capabilities.usageStats.contextWindow === true &&
    tokenStats !== undefined;
  const selectedModel =
    settings?.selectedModel ??
    capabilities?.model.selected ??
    capabilities?.model.options[0]?.value ??
    '';
  const selectedReasoningEffort =
    settings?.reasoningEffort ??
    capabilities?.reasoning.selected ??
    capabilities?.reasoning.options[0]?.value ??
    '';
  const provider = capabilities?.provider ?? null;

  return {
    provider,
    selectedModel,
    selectedReasoningEffort,
    showModelSelector,
    showReasoningSelector,
    showThinkingToggle,
    showPlanToggle,
    showAttachments,
    showUsageIndicator,
  };
}

function getProviderLogo(provider: ChatBarCapabilities['provider'] | null): {
  light: string;
  dark: string;
  alt: string;
} {
  if (provider === 'CODEX') {
    return {
      light: '/logos/codex-light.svg',
      dark: '/logos/codex-dark.svg',
      alt: 'Codex',
    };
  }
  return {
    light: '/logos/claude-light.svg',
    dark: '/logos/claude-dark.svg',
    alt: 'Claude',
  };
}

const ProviderIndicator = memo(function ProviderIndicator({
  provider,
}: {
  provider: ChatBarCapabilities['provider'] | null;
}) {
  if (!provider) {
    return null;
  }
  const logo = getProviderLogo(provider);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground">
            <img src={logo.light} alt={logo.alt} className="h-3.5 w-3.5 shrink-0 dark:hidden" />
            <img
              src={logo.dark}
              alt={logo.alt}
              className="hidden h-3.5 w-3.5 shrink-0 dark:block"
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{logo.alt}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

const ModeToggles = memo(function ModeToggles({
  showThinkingToggle,
  showPlanToggle,
  settings,
  onThinkingChange,
  onPlanModeChange,
  running,
  modLabel,
  modifierHeld,
}: {
  showThinkingToggle: boolean;
  showPlanToggle: boolean;
  settings?: ChatSettings;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  running: boolean;
  modLabel: string;
  modifierHeld: boolean;
}) {
  if (!(showThinkingToggle || showPlanToggle)) {
    return null;
  }

  return (
    <>
      {showThinkingToggle && (
        <SettingsToggle
          pressed={settings?.thinkingEnabled ?? false}
          onPressedChange={onThinkingChange}
          disabled={running}
          icon={Brain}
          label="Extended thinking mode"
          ariaLabel="Toggle thinking mode"
          shortcut={`${modLabel}+Shift+T`}
          showShortcut={modifierHeld}
        />
      )}
      {showPlanToggle && (
        <SettingsToggle
          pressed={settings?.planModeEnabled ?? false}
          onPressedChange={onPlanModeChange}
          disabled={running}
          icon={MapIcon}
          label="Plan mode"
          ariaLabel="Toggle plan mode"
          shortcut={`${modLabel}+Shift+P`}
          showShortcut={modifierHeld}
        />
      )}
    </>
  );
});

const UsageIndicatorSection = memo(function UsageIndicatorSection({
  showUsageIndicator,
  tokenStats,
}: {
  showUsageIndicator: boolean;
  tokenStats?: TokenStats;
}) {
  if (!(showUsageIndicator && tokenStats)) {
    return null;
  }

  return (
    <>
      <div className="h-4 w-px bg-border" />
      <ContextWindowIndicator tokenStats={tokenStats} />
    </>
  );
});

/**
 * Renders the left controls: model selector, toggles, file upload, and context indicator.
 */
const LeftControls = memo(function LeftControls({
  settings,
  capabilities,
  onModelChange,
  onReasoningChange,
  onThinkingChange,
  onPlanModeChange,
  running,
  modLabel,
  modifierHeld,
  fileInputRef,
  onFileSelect,
  supportedImageTypes,
  disabled,
  onQuickAction,
  quickActionsOpen,
  onQuickActionsOpenChange,
  tokenStats,
}: {
  settings?: ChatSettings;
  capabilities?: ChatBarCapabilities;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  running: boolean;
  modLabel: string;
  modifierHeld: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  disabled: boolean;
  onQuickAction: (action: string) => void;
  quickActionsOpen: boolean;
  onQuickActionsOpenChange: (open: boolean) => void;
  tokenStats?: TokenStats;
}) {
  const {
    provider,
    selectedModel,
    selectedReasoningEffort,
    showModelSelector,
    showReasoningSelector,
    showThinkingToggle,
    showPlanToggle,
    showAttachments,
    showUsageIndicator,
  } = deriveLeftControlsVisibility(settings, capabilities, tokenStats);
  const hasModeToggles = showThinkingToggle || showPlanToggle;

  return (
    <div className="flex items-center gap-1">
      <ProviderIndicator provider={provider} />
      {(showModelSelector || showReasoningSelector || hasModeToggles) && (
        <div className="h-4 w-px bg-border" />
      )}
      {showModelSelector && (
        <ModelSelector
          selectedModel={selectedModel}
          options={capabilities?.model.options ?? []}
          onChange={onModelChange}
          disabled={running}
        />
      )}
      {showModelSelector && showReasoningSelector && <div className="h-4 w-px bg-border" />}
      {showReasoningSelector && (
        <ModelSelector
          selectedModel={selectedReasoningEffort}
          options={(capabilities?.reasoning.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={onReasoningChange}
          disabled={running}
        />
      )}
      {(showModelSelector || showReasoningSelector) && hasModeToggles && (
        <div className="h-4 w-px bg-border" />
      )}
      <ModeToggles
        showThinkingToggle={showThinkingToggle}
        showPlanToggle={showPlanToggle}
        settings={settings}
        onThinkingChange={onThinkingChange}
        onPlanModeChange={onPlanModeChange}
        running={running}
        modLabel={modLabel}
        modifierHeld={modifierHeld}
      />
      {hasModeToggles && showAttachments && <div className="h-4 w-px bg-border" />}
      {showAttachments && (
        <FileUploadButton
          fileInputRef={fileInputRef}
          onFileSelect={onFileSelect}
          supportedImageTypes={supportedImageTypes}
          running={running}
          disabled={disabled}
          modLabel={modLabel}
          modifierHeld={modifierHeld}
        />
      )}
      <QuickActionsDropdown
        onAction={onQuickAction}
        disabled={disabled}
        open={quickActionsOpen}
        onOpenChange={onQuickActionsOpenChange}
        shortcut={`${modLabel}+Shift+A`}
        showShortcut={modifierHeld}
      />
      <UsageIndicatorSection showUsageIndicator={showUsageIndicator} tokenStats={tokenStats} />
    </div>
  );
});

/**
 * Renders the right controls: pending indicator, stop button, and send button.
 */
const RightControls = memo(function RightControls({
  pendingMessageCount,
  running,
  stopping,
  onStop,
  onSendClick,
  disabled,
  inputRef,
}: {
  pendingMessageCount: number;
  running: boolean;
  stopping: boolean;
  onStop?: () => void;
  onSendClick: (ref: React.RefObject<HTMLTextAreaElement | null>) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="flex items-center gap-1">
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
      <InputGroupButton
        onClick={() => onSendClick(inputRef)}
        disabled={disabled}
        size="icon-sm"
        aria-label={running ? 'Queue message' : 'Send message'}
      >
        <Send className="h-4 w-4" />
      </InputGroupButton>
    </div>
  );
});

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
          className="flex items-center justify-between border-t !pt-1 !pb-1"
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
