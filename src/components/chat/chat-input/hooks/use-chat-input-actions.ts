import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';

import type { ChatSettings, MessageAttachment } from '@/lib/claude-types';
import { fileToAttachment, SUPPORTED_IMAGE_TYPES } from '@/lib/image-utils';

import type { SlashKeyResult } from '../../slash-command-palette';

interface UseChatInputActionsOptions {
  onSend: (text: string) => void;
  onStop?: () => void;
  onOpenQuickActions?: () => void;
  onCloseSlashMenu?: () => void;
  onChange?: (value: string) => void;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
  disabled: boolean;
  running: boolean;
  stopping?: boolean;
  settings?: ChatSettings;
  attachments: MessageAttachment[];
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void;
  delegateToSlashMenu: (key: string) => SlashKeyResult;
}

interface UseChatInputActionsReturn {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleSendClick: (inputRef: React.RefObject<HTMLTextAreaElement | null>) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRemoveAttachment: (id: string) => void;
  handleQuickAction: (message: string) => void;
  handleModelChange: (model: string) => void;
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
  onChange,
  onSettingsChange,
  disabled,
  running,
  stopping,
  settings,
  attachments,
  setAttachments,
  delegateToSlashMenu,
}: UseChatInputActionsOptions): UseChatInputActionsReturn {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        action: () => {
          if (!running) {
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
          sendFromInput(event.currentTarget);
        },
      },
      {
        key: 'p',
        mod: true,
        shift: true,
        alt: false,
        action: () => {
          if (!running) {
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
          if (!running) {
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
          if (!(running || disabled)) {
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
      onOpenQuickActions,
      onSettingsChange,
      onStop,
      running,
      sendFromInput,
      settings?.planModeEnabled,
      settings?.thinkingEnabled,
      stopping,
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
      const result = delegateToSlashMenu(event.key);
      if (result === 'handled') {
        event.preventDefault();
        return;
      }
      // 'close-and-passthrough' falls through to normal handling

      // Post-slash shortcuts (e.g., Enter send)
      runShortcuts(event, postSlashShortcuts);
    },
    [preSlashShortcuts, delegateToSlashMenu, postSlashShortcuts]
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

  return {
    fileInputRef,
    handleKeyDown,
    handleSendClick,
    handleFileSelect,
    handleRemoveAttachment,
    handleQuickAction,
    handleModelChange,
    handleThinkingChange,
    handlePlanModeChange,
    supportedImageTypes: SUPPORTED_IMAGE_TYPES,
  };
}
