import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import type { FileMentionKeyResult } from '@/components/chat/file-mention-palette';
import type { SlashKeyResult } from '@/components/chat/slash-command-palette';
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import { fileToAttachment, SUPPORTED_IMAGE_TYPES } from '@/lib/image-utils';
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

interface ShortcutDefinition {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  action: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  shouldHandle?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  preventDefault?: boolean;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function matchesShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcut: ShortcutDefinition
): boolean {
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) {
    return false;
  }

  if (shortcut.mod !== undefined) {
    const hasMod = event.metaKey || event.ctrlKey;
    if (shortcut.mod !== hasMod) {
      return false;
    }
  }
  if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) {
    return false;
  }
  if (shortcut.alt !== undefined && shortcut.alt !== event.altKey) {
    return false;
  }
  if (shortcut.ctrl !== undefined && shortcut.ctrl !== event.ctrlKey) {
    return false;
  }
  if (shortcut.meta !== undefined && shortcut.meta !== event.metaKey) {
    return false;
  }

  return true;
}

function runShortcuts(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcuts: ShortcutDefinition[]
): boolean {
  for (const shortcut of shortcuts) {
    if (matchesShortcut(event, shortcut)) {
      if (shortcut.shouldHandle && !shortcut.shouldHandle(event)) {
        continue;
      }
      if (shortcut.preventDefault !== false) {
        event.preventDefault();
      }
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
  const planModeEnabled = capabilities?.planMode.enabled === true;
  const thinkingEnabled = capabilities?.thinking.enabled === true;
  const imageAttachmentsEnabled =
    capabilities?.attachments.enabled === true && capabilities.attachments.kinds.includes('image');
  const modelSelectorEnabled = capabilities?.model.enabled === true;
  const reasoningSelectorEnabled = capabilities?.reasoning.enabled === true;
  const modelValues = new Set(capabilities?.model.options.map((option) => option.value) ?? []);
  const reasoningValues = new Set(
    capabilities?.reasoning.options.map((option) => option.value) ?? []
  );

  const sendFromInput = useCallback(
    (inputElement: HTMLTextAreaElement | null) => {
      if (!inputElement) {
        return;
      }
      const text = inputElement.value.trim();
      if ((text || attachments.length > 0) && !disabled) {
        onSend(text);
        inputElement.value = '';
        onChange?.('');
        setAttachments([]);
      }
    },
    [attachments.length, disabled, onChange, onSend, setAttachments]
  );

  const preSlashShortcuts = useMemo<ShortcutDefinition[]>(
    () => [
      {
        key: 'Tab',
        shift: true,
        shouldHandle: () => !running,
        action: () => {
          if (planModeEnabled) {
            onSettingsChange?.({ planModeEnabled: !settings?.planModeEnabled });
          }
        },
      },
      {
        key: 'Enter',
        mod: true,
        shift: false,
        alt: false,
        action: (event) => {
          onCloseSlashMenu?.();
          onCloseFileMentionMenu?.();
          sendFromInput(event.currentTarget);
        },
      },
      {
        key: 'p',
        mod: true,
        shift: true,
        alt: false,
        action: () => {
          if (!running && planModeEnabled) {
            onSettingsChange?.({ planModeEnabled: !settings?.planModeEnabled });
          }
        },
      },
      {
        key: 't',
        mod: true,
        shift: true,
        alt: false,
        action: () => {
          if (!running && thinkingEnabled) {
            onSettingsChange?.({ thinkingEnabled: !settings?.thinkingEnabled });
          }
        },
      },
      {
        key: 'u',
        mod: true,
        shift: true,
        alt: false,
        action: () => {
          if (!(running || disabled) && imageAttachmentsEnabled) {
            fileInputRef.current?.click();
          }
        },
      },
      {
        key: 'a',
        mod: true,
        shift: true,
        alt: false,
        action: () => {
          if (!disabled) {
            onOpenQuickActions?.();
          }
        },
      },
      {
        key: '.',
        mod: true,
        shift: false,
        alt: false,
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
      settings?.planModeEnabled,
      settings?.thinkingEnabled,
      stopping,
      planModeEnabled,
      thinkingEnabled,
      imageAttachmentsEnabled,
    ]
  );

  const postSlashShortcuts = useMemo<ShortcutDefinition[]>(
    () => [
      {
        key: 'Enter',
        shift: false,
        alt: false,
        mod: false,
        action: (event) => {
          sendFromInput(event.currentTarget);
        },
      },
    ],
    [sendFromInput]
  );

  // Handle key press for Enter to send and Shift+Tab for plan mode toggle
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Run pre-slash shortcuts first (e.g., Shift+Tab)
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

  const handlePlanModeChange = useCallback(
    (pressed: boolean) => {
      if (planModeEnabled) {
        onSettingsChange?.({ planModeEnabled: pressed });
      }
    },
    [planModeEnabled, onSettingsChange]
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
