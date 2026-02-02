import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

import type { ChatSettings, MessageAttachment } from '@/lib/claude-types';
import { fileToAttachment, SUPPORTED_IMAGE_TYPES } from '@/lib/image-utils';

import type { SlashKeyResult } from '../../slash-command-palette';

interface UseChatInputActionsOptions {
  onSend: (text: string) => void;
  onChange?: (value: string) => void;
  onSettingsChange?: (settings: Partial<ChatSettings>) => void;
  disabled: boolean;
  running: boolean;
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

/**
 * Manages chat input action handlers: keyboard, send, file upload, settings.
 */
export function useChatInputActions({
  onSend,
  onChange,
  onSettingsChange,
  disabled,
  running,
  settings,
  attachments,
  setAttachments,
  delegateToSlashMenu,
}: UseChatInputActionsOptions): UseChatInputActionsReturn {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle key press for Enter to send and Shift+Tab for plan mode toggle
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Tab toggles plan mode (check BEFORE slash menu to ensure it always works)
      // Only toggle when not running, matching the button's disabled state
      if (event.key === 'Tab' && event.shiftKey && !running) {
        event.preventDefault();
        onSettingsChange?.({ planModeEnabled: !settings?.planModeEnabled });
        return;
      }

      // If slash menu is open, delegate to palette for key handling
      const result = delegateToSlashMenu(event.key);
      if (result === 'handled') {
        event.preventDefault();
        return;
      }
      // 'close-and-passthrough' falls through to normal handling

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
    [
      onSend,
      disabled,
      running,
      onChange,
      setAttachments,
      attachments,
      delegateToSlashMenu,
      settings,
      onSettingsChange,
    ]
  );

  // Handle send button click
  const handleSendClick = useCallback(
    (inputRef: React.RefObject<HTMLTextAreaElement | null>) => {
      if (inputRef?.current) {
        const text = inputRef.current.value.trim();
        if ((text || attachments.length > 0) && !disabled) {
          onSend(text);
          inputRef.current.value = '';
          onChange?.('');
          setAttachments([]);
        }
      }
    },
    [onSend, disabled, onChange, setAttachments, attachments]
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
