import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { getRuntimeControlVisibility } from '@/client/features/chat/chat-input/runtime-control-visibility';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import type { FileMentionKeyResult, SlashKeyResult } from '@/client/features/composer';
import { collectAttachments } from '@/client/lib/attachment-file-conversion';
import { matchesShortcut, type ShortcutId } from '@/client/lib/keyboard-shortcuts';
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import { SUPPORTED_IMAGE_TYPES } from '@/lib/image-utils';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

interface UseChatInputActionsOptions {
  onSend: (text: string) => void;
  onStop?: () => void;
  onOpenQuickActions?: () => void;
  onCloseSlashMenu?: () => void;
  onCloseFileMentionMenu?: () => void;
  onChange?: (value: string) => void;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
  capabilities?: ChatBarCapabilities;
  /** Native ACP options; used to skip shortcuts for legacy controls they replace. */
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
  disabled: boolean;
  running: boolean;
  stopping?: boolean;
  settings?: ChatSettings;
  attachments: MessageAttachment[];
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void;
  delegateToSlashMenu: (key: string) => SlashKeyResult;
  delegateToFileMentionMenu: (key: string) => FileMentionKeyResult;
}

interface UseChatInputActionsReturn {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleSendClick: (inputRef: React.RefObject<HTMLTextAreaElement | null>) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRemoveAttachment: (id: string) => void;
  handleQuickAction: (message: string) => void;
  handleModelChange: (model: string) => void;
  handleReasoningChange: (effort: string) => void;
  handleThinkingChange: (pressed: boolean) => void;
  handlePlanModeChange: (pressed: boolean) => void;
  supportedImageTypes: readonly string[];
}

interface ComposerShortcut {
  id: ShortcutId;
  /** Extra condition, such as ⌘↵ sending while a menu is open but plain ↵ not. */
  when?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  action: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** Runs the first composer shortcut from the registry that matches the key press. */
function runShortcuts(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcuts: ComposerShortcut[]
): boolean {
  for (const shortcut of shortcuts) {
    if (matchesShortcut(event, shortcut.id) && (!shortcut.when || shortcut.when(event))) {
      event.preventDefault();
      shortcut.action(event);
      return true;
    }
  }
  return false;
}

/**
 * Manages chat input action handlers: keyboard, send, file upload, settings.
 */
export function useChatInputActions({
  onSend,
  onStop,
  onOpenQuickActions,
  onCloseSlashMenu,
  onCloseFileMentionMenu,
  onChange,
  onSettingsChange,
  capabilities,
  acpConfigOptions,
  onSetConfigOption,
  disabled,
  running,
  stopping,
  settings,
  attachments,
  setAttachments,
  delegateToSlashMenu,
  delegateToFileMentionMenu,
}: UseChatInputActionsOptions): UseChatInputActionsReturn {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A native effort option replaces the legacy thinking toggle; the legacy budget would be a no-op.
  const {
    showThinking: thinkingEnabled,
    showPlanning: planModeEnabled,
    planningOption,
  } = getRuntimeControlVisibility({
    capabilities,
    acpConfigOptions,
    onSetConfigOption,
  });
  const imageAttachmentsEnabled =
    capabilities?.attachments.enabled === true && capabilities.attachments.kinds.includes('image');
  const modelSelectorEnabled = capabilities?.model.enabled === true;
  const reasoningSelectorEnabled = capabilities?.reasoning.enabled === true;
  const modelOptions = capabilities?.model.options;
  const reasoningOptions = capabilities?.reasoning.options;
  // Stable sets keep the change handlers, and the memoized controls using them, stable.
  const modelValues = useMemo(
    () => new Set(modelOptions?.map((option) => option.value) ?? []),
    [modelOptions]
  );
  const reasoningValues = useMemo(
    () => new Set(reasoningOptions?.map((option) => option.value) ?? []),
    [reasoningOptions]
  );

  const sendFromInput = useCallback(
    (inputElement: HTMLTextAreaElement | null) => {
      if (!inputElement) {
        return false;
      }
      const text = inputElement.value.trim();
      if ((text || attachments.length > 0) && !disabled) {
        onSend(text);
        inputElement.value = '';
        onChange?.('');
        setAttachments([]);
        return true;
      }
      return false;
    },
    [attachments.length, disabled, onChange, onSend, setAttachments]
  );

  const handlePlanModeChange = useCallback(
    (pressed: boolean) => {
      if (disabled || stopping) {
        return;
      }
      if (planningOption) {
        const choices = planningOption.options.flatMap((entry) =>
          'group' in entry ? entry.options : [entry]
        );
        const returnValue = choices.find((choice) => choice.value === 'default')?.value;
        const target = pressed ? 'plan' : returnValue;
        if (!(target && choices.some((choice) => choice.value === target))) {
          return;
        }
        onSetConfigOption?.(planningOption.id, target);
      } else if (planModeEnabled) {
        onSettingsChange?.({ planModeEnabled: pressed });
      }
    },
    [disabled, stopping, planningOption, planModeEnabled, onSetConfigOption, onSettingsChange]
  );

  const preSlashShortcuts = useMemo<ComposerShortcut[]>(
    () => [
      {
        id: 'composer.send',
        when: (event) => event.metaKey || event.ctrlKey,
        action: (event) => {
          if (sendFromInput(event.currentTarget)) {
            onCloseSlashMenu?.();
            onCloseFileMentionMenu?.();
          }
        },
      },
      {
        id: 'composer.togglePlanMode',
        action: () => {
          handlePlanModeChange(
            planningOption ? planningOption.currentValue !== 'plan' : !settings?.planModeEnabled
          );
        },
      },
      {
        id: 'composer.toggleThinking',
        action: () => {
          if (!(disabled || stopping) && thinkingEnabled) {
            onSettingsChange?.({ thinkingEnabled: !settings?.thinkingEnabled });
          }
        },
      },
      {
        id: 'composer.attachImage',
        action: () => {
          if (!disabled && imageAttachmentsEnabled) {
            fileInputRef.current?.click();
          }
        },
      },
      {
        id: 'composer.quickActions',
        action: () => {
          if (!disabled) {
            onOpenQuickActions?.();
          }
        },
      },
      {
        id: 'composer.stop',
        action: () => {
          if (running && !stopping) {
            onStop?.();
          }
        },
      },
    ],
    [
      disabled,
      onCloseSlashMenu,
      onCloseFileMentionMenu,
      onOpenQuickActions,
      onSettingsChange,
      onStop,
      running,
      sendFromInput,
      settings?.thinkingEnabled,
      settings?.planModeEnabled,
      stopping,
      thinkingEnabled,
      handlePlanModeChange,
      planningOption,
      imageAttachmentsEnabled,
    ]
  );

  const postSlashShortcuts = useMemo<ComposerShortcut[]>(
    () => [
      {
        id: 'composer.send',
        when: (event) => !(event.metaKey || event.ctrlKey),
        action: (event) => {
          sendFromInput(event.currentTarget);
        },
      },
    ],
    [sendFromInput]
  );

  // Handle key press shortcuts before and after slash/file menus.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }

      // Run pre-slash shortcuts first.
      if (runShortcuts(event, preSlashShortcuts)) {
        return;
      }

      // If slash menu is open, delegate to palette for key handling
      const slashResult = delegateToSlashMenu(event.key);
      if (slashResult === 'handled') {
        event.preventDefault();
        return;
      }
      // 'close-and-passthrough' falls through to normal handling

      // If file mention menu is open, delegate to palette for key handling
      const fileMentionResult = delegateToFileMentionMenu(event.key);
      if (fileMentionResult === 'handled') {
        event.preventDefault();
        return;
      }
      // 'close-and-passthrough' falls through to normal handling

      // Post-slash shortcuts (e.g., Enter send)
      runShortcuts(event, postSlashShortcuts);
    },
    [preSlashShortcuts, delegateToSlashMenu, delegateToFileMentionMenu, postSlashShortcuts]
  );

  // Handle send button click
  const handleSendClick = useCallback(
    (inputRef: React.RefObject<HTMLTextAreaElement | null>) => {
      sendFromInput(inputRef?.current ?? null);
    },
    [sendFromInput]
  );

  // Handle file selection
  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }

      const { attachments: newAttachments, errors } = await collectAttachments({
        mode: 'images-only',
        files,
      });

      // Show error toasts for failed files
      for (const { fileName, message } of errors) {
        toast.error(`Couldn't upload ${fileName}. ${message}`);
      }

      // Add successful attachments to state
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

  // Handle quick action - sends the predefined message
  const handleQuickAction = useCallback(
    (message: string) => {
      if (!disabled) {
        onSend(message);
      }
    },
    [onSend, disabled]
  );

  // Settings change handlers
  const handleModelChange = useCallback(
    (model: string) => {
      if (modelSelectorEnabled && modelValues.has(model)) {
        onSettingsChange?.({ selectedModel: model });
      }
    },
    [modelSelectorEnabled, modelValues, onSettingsChange]
  );

  const handleThinkingChange = useCallback(
    (pressed: boolean) => {
      if (thinkingEnabled) {
        onSettingsChange?.({ thinkingEnabled: pressed });
      }
    },
    [thinkingEnabled, onSettingsChange]
  );

  const handleReasoningChange = useCallback(
    (effort: string) => {
      if (reasoningSelectorEnabled && reasoningValues.has(effort)) {
        onSettingsChange?.({ reasoningEffort: effort });
      }
    },
    [reasoningSelectorEnabled, reasoningValues, onSettingsChange]
  );

  return {
    fileInputRef,
    handleKeyDown,
    handleSendClick,
    handleFileSelect,
    handleRemoveAttachment,
    handleQuickAction,
    handleModelChange,
    handleReasoningChange,
    handleThinkingChange,
    handlePlanModeChange,
    supportedImageTypes: SUPPORTED_IMAGE_TYPES,
  };
}
