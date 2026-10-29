// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import {
  type ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  type MessageAttachment,
} from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { useChatInputActions } from './use-chat-input-actions';

interface ShortcutHarnessProps {
  capabilities: ChatBarCapabilities;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
  disabled?: boolean;
  running?: boolean;
  settingsPlanEnabled?: boolean;
  settingsThinkingEnabled?: boolean;
  onCloseSlashMenu?: () => void;
  onSend?: (text: string) => void;
  onSettingsChange: (settings: Partial<ChatSettings>) => void;
}

function ShortcutHarness({
  capabilities,
  acpConfigOptions,
  onSetConfigOption,
  disabled = false,
  running = false,
  settingsPlanEnabled = false,
  settingsThinkingEnabled = false,
  onCloseSlashMenu = () => undefined,
  onSend = () => undefined,
  onSettingsChange,
}: ShortcutHarnessProps) {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const actions = useChatInputActions({
    onSend,
    onStop: () => undefined,
    onOpenQuickActions: () => undefined,
    onCloseSlashMenu,
    onCloseFileMentionMenu: () => undefined,
    onChange: () => undefined,
    onSettingsChange,
    capabilities,
    acpConfigOptions,
    onSetConfigOption,
    disabled,
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

function dispatchModShortcut(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  flushSync(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

function claudeChatBarCapabilities(): ChatBarCapabilities {
  return {
    provider: 'CLAUDE',
    model: {
      enabled: true,
      options: [
        { value: 'opus', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
      selected: 'sonnet',
    },
    reasoning: { enabled: false, options: [] },
    thinking: { enabled: true, defaultBudget: 10_000 },
    planMode: { enabled: true },
    attachments: { enabled: true, kinds: ['image', 'text'] },
    slashCommands: { enabled: true },
    usageStats: { enabled: true, contextWindow: true },
    rewind: { enabled: true },
  };
}

function claudeNativeConfigOptions(): AcpConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'acceptEdits',
      options: [
        { value: 'acceptEdits', name: 'Accept edits' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      type: 'select',
      category: 'thought_level',
      currentValue: 'high',
      options: [
        { value: 'high', name: 'High' },
        { value: 'low', name: 'Low' },
      ],
    },
  ];
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useChatInputActions keyboard shortcuts', () => {
  it('does not send when Enter confirms an IME composition', () => {
    const onSend = vi.fn();
    const capabilities = claudeChatBarCapabilities();
    const { root, container, textarea } = renderHarness({
      capabilities,
      onSend,
      onSettingsChange: () => undefined,
    });
    textarea.value = 'テスト';

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    flushSync(() => {
      textarea.dispatchEvent(event);
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('テスト');

    root.unmount();
    container.remove();
  });

  it('does not dismiss the slash menu when a Mod+Enter send is skipped', () => {
    const onCloseSlashMenu = vi.fn();
    const onSend = vi.fn();
    const capabilities = claudeChatBarCapabilities();
    const { root, container, textarea } = renderHarness({
      capabilities,
      disabled: true,
      onCloseSlashMenu,
      onSend,
      onSettingsChange: () => undefined,
    });
    textarea.value = '/help';

    dispatchModShortcut(textarea, 'Enter');

    expect(onSend).not.toHaveBeenCalled();
    expect(onCloseSlashMenu).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it('closes the slash menu after a successful Mod+Enter send', () => {
    const onCloseSlashMenu = vi.fn();
    const onSend = vi.fn();
    const capabilities = claudeChatBarCapabilities();
    const { root, container, textarea } = renderHarness({
      capabilities,
      onCloseSlashMenu,
      onSend,
      onSettingsChange: () => undefined,
    });
    textarea.value = '/help';

    dispatchModShortcut(textarea, 'Enter');

    expect(onSend).toHaveBeenCalledWith('/help');
    expect(onCloseSlashMenu).toHaveBeenCalledOnce();
    expect(textarea.value).toBe('');

    root.unmount();
    container.remove();
  });

  it('toggles plan mode with Mod+Shift+P when plan mode is enabled', () => {
    const onSettingsChange = vi.fn();
    const capabilities = claudeChatBarCapabilities();
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

  it('toggles plan mode with Mod+Shift+P for the next turn while running', () => {
    const onSettingsChange = vi.fn();
    const capabilities = claudeChatBarCapabilities();
    const { root, container, textarea } = renderHarness({
      capabilities,
      onSettingsChange,
      running: true,
      settingsPlanEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 'p');

    expect(onSettingsChange).toHaveBeenCalledWith({ planModeEnabled: true });

    root.unmount();
    container.remove();
  });

  it('toggles thinking mode with Mod+Shift+T when thinking is enabled', () => {
    const onSettingsChange = vi.fn();
    const capabilities = claudeChatBarCapabilities();
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

  it('ignores Mod+Shift+T when a native Claude effort option replaces the thinking toggle', () => {
    const onSettingsChange = vi.fn();
    const onSetConfigOption = vi.fn();
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: claudeNativeConfigOptions(),
      onSetConfigOption,
      onSettingsChange,
      settingsThinkingEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 't');

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onSetConfigOption).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it('keeps Mod+Shift+T on the legacy toggle when native options are read-only', () => {
    const onSettingsChange = vi.fn();
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: claudeNativeConfigOptions(),
      onSettingsChange,
      settingsThinkingEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 't');

    expect(onSettingsChange).toHaveBeenCalledWith({ thinkingEnabled: true });

    root.unmount();
    container.remove();
  });

  it('queues plan mode with Mod+Shift+P alongside a native Claude mode option', () => {
    const onSettingsChange = vi.fn();
    const onSetConfigOption = vi.fn();
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: claudeNativeConfigOptions(),
      onSetConfigOption,
      onSettingsChange,
      settingsPlanEnabled: false,
    });

    dispatchModShiftShortcut(textarea, 'p');

    expect(onSettingsChange).toHaveBeenCalledWith({ planModeEnabled: true });
    expect(onSetConfigOption).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });
});
