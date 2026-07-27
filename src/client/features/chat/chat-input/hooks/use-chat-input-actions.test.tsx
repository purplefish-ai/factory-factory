// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  type MessageAttachment,
} from '@/lib/chat-protocol';
import {
  type ChatBarCapabilities,
  createClaudeChatBarCapabilities,
} from '@/shared/chat-capabilities';
import { useChatInputActions } from './use-chat-input-actions';

interface ShortcutHarnessProps {
  capabilities: ChatBarCapabilities;
  running?: boolean;
  settingsPlanEnabled?: boolean;
  settingsThinkingEnabled?: boolean;
  onSettingsChange: (settings: Partial<ChatSettings>) => void;
}

function ShortcutHarness({
  capabilities,
  running = false,
  settingsPlanEnabled = false,
  settingsThinkingEnabled = false,
  onSettingsChange,
}: ShortcutHarnessProps) {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const actions = useChatInputActions({
    onSend: () => undefined,
    onStop: () => undefined,
    onOpenQuickActions: () => undefined,
    onCloseSlashMenu: () => undefined,
    onCloseFileMentionMenu: () => undefined,
    onChange: () => undefined,
    onSettingsChange,
    capabilities,
    disabled: false,
    running,
    settings: {
      ...DEFAULT_CHAT_SETTINGS,
      planModeEnabled: settingsPlanEnabled,
      thinkingEnabled: settingsThinkingEnabled,
    },
    attachments,
    setAttachments,
    delegateToSlashMenu: () => 'passthrough',
    delegateToFileMentionMenu: () => 'passthrough',
  });

  return createElement('textarea', {
    onKeyDown: actions.handleKeyDown,
    'data-testid': 'shortcut-input',
  });
}

function renderHarness(props: ShortcutHarnessProps): {
  container: HTMLDivElement;
  root: Root;
  textarea: HTMLTextAreaElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ShortcutHarness, props));
  });

  const textarea = container.querySelector('textarea');
  if (!textarea) {
    throw new Error('Expected textarea to render');
  }

  return { container, root, textarea };
}

function dispatchModShiftShortcut(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  flushSync(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useChatInputActions keyboard shortcuts', () => {
  it('toggles plan mode with Mod+Shift+P when plan mode is enabled', () => {
    const onSettingsChange = vi.fn();
    const capabilities = createClaudeChatBarCapabilities('sonnet');
    const { root, container, textarea } = renderHarness({
      capabilities,
      onSettingsChange,
      settingsPlanEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 'p');

    expect(onSettingsChange).toHaveBeenCalledWith({ planModeEnabled: true });

    root.unmount();
    container.remove();
  });

  it('does not toggle plan mode with Mod+Shift+P while running', () => {
    const onSettingsChange = vi.fn();
    const capabilities = createClaudeChatBarCapabilities('sonnet');
    const { root, container, textarea } = renderHarness({
      capabilities,
      onSettingsChange,
      running: true,
      settingsPlanEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 'p');

    expect(onSettingsChange).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it('toggles thinking mode with Mod+Shift+T when thinking is enabled', () => {
    const onSettingsChange = vi.fn();
    const capabilities = createClaudeChatBarCapabilities('sonnet');
    const { root, container, textarea } = renderHarness({
      capabilities,
      onSettingsChange,
      settingsThinkingEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 't');

    expect(onSettingsChange).toHaveBeenCalledWith({ thinkingEnabled: true });

    root.unmount();
    container.remove();
  });
});
