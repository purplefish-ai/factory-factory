// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
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

const uploadErrors = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: uploadErrors } }));

interface ShortcutHarnessProps {
  capabilities: ChatBarCapabilities;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
  disabled?: boolean;
  running?: boolean;
  stopping?: boolean;
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
  stopping = false,
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
    stopping,
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

  return (
    <>
      <button onClick={() => actions.handlePlanModeChange(false)}>Leave plan</button>
      <textarea onKeyDown={actions.handleKeyDown} data-testid="shortcut-input" />
      <input
        type="file"
        ref={actions.fileInputRef}
        onChange={(event) => {
          void actions.handleFileSelect(event);
        }}
      />
      <output>{attachments.map(({ name }) => name).join(', ')}</output>
    </>
  );
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
  it.each([false, true])('opens image upload while running unless disabled=%s', (disabled) => {
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      running: true,
      disabled,
      onSettingsChange: () => undefined,
    });
    try {
      const picker = vi.spyOn(container.querySelector('input')!, 'click');
      dispatchModShiftShortcut(textarea, 'u');
      expect(picker).toHaveBeenCalledTimes(disabled ? 0 : 1);
    } finally {
      flushSync(() => root.unmount());
      container.remove();
    }
  });

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

  it('sets the native mode with Mod+Shift+P when it owns planning', () => {
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

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onSetConfigOption).toHaveBeenCalledWith('mode', 'plan');

    root.unmount();
    container.remove();
  });

  it.each([false, true])('leaves native plan mode with grouped choices=%s', (grouped) => {
    const onSettingsChange = vi.fn();
    const onSetConfigOption = vi.fn();
    const options = claudeNativeConfigOptions();
    const mode = options[0]!;
    mode.currentValue = 'plan';
    if (grouped) {
      mode.options = [
        {
          group: 'Modes',
          options: [
            { value: 'acceptEdits', name: 'Accept edits' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ];
    }
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: options,
      onSetConfigOption,
      onSettingsChange,
    });
    dispatchModShiftShortcut(textarea, 'p');
    expect(onSetConfigOption).toHaveBeenCalledWith('mode', 'acceptEdits');
    expect(onSettingsChange).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it.each([{ disabled: true }, { stopping: true }])(
    'does not change native planning while %j',
    (state) => {
      const onSettingsChange = vi.fn();
      const onSetConfigOption = vi.fn();
      const { root, container, textarea } = renderHarness({
        capabilities: claudeChatBarCapabilities(),
        acpConfigOptions: claudeNativeConfigOptions(),
        onSetConfigOption,
        onSettingsChange,
        ...state,
      });
      dispatchModShiftShortcut(textarea, 'p');
      expect(onSetConfigOption).not.toHaveBeenCalled();
      expect(onSettingsChange).not.toHaveBeenCalled();
      root.unmount();
      container.remove();
    }
  );

  it('routes the planning handler through the native option too', () => {
    const onSettingsChange = vi.fn();
    const onSetConfigOption = vi.fn();
    const options = claudeNativeConfigOptions();
    options[0]!.currentValue = 'plan';
    const { root, container } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: options,
      onSetConfigOption,
      onSettingsChange,
    });
    flushSync(() => container.querySelector('button')!.click());
    expect(onSetConfigOption).toHaveBeenCalledWith('mode', 'acceptEdits');
    expect(onSettingsChange).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it('does not invent a native exit mode or fall back to legacy planning', () => {
    const onSettingsChange = vi.fn();
    const onSetConfigOption = vi.fn();
    const options = claudeNativeConfigOptions();
    options[0] = {
      ...options[0]!,
      currentValue: 'plan',
      options: [{ value: 'plan', name: 'Plan' }],
    };
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: options,
      onSetConfigOption,
      onSettingsChange,
    });
    dispatchModShiftShortcut(textarea, 'p');
    expect(onSetConfigOption).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it('retains the legacy shortcut when native options cannot be edited', () => {
    const onSettingsChange = vi.fn();
    const { root, container, textarea } = renderHarness({
      capabilities: claudeChatBarCapabilities(),
      acpConfigOptions: claudeNativeConfigOptions(),
      onSettingsChange,
    });
    dispatchModShiftShortcut(textarea, 'p');
    expect(onSettingsChange).toHaveBeenCalledWith({ planModeEnabled: true });
    root.unmount();
    container.remove();
  });
});

it('selects only images, preserves successful files and presents per-file errors', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  uploadErrors.mockClear();
  const { root, container } = renderHarness({
    capabilities: claudeChatBarCapabilities(),
    onSettingsChange: vi.fn(),
  });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    value: [
      new File(['image'], 'selected.png', { type: 'image/png' }),
      new File(['text'], 'notes.md', { type: 'text/plain' }),
    ],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(uploadErrors).toHaveBeenCalled());
  });
  expect(uploadErrors).toHaveBeenCalledWith(
    'Failed to upload notes.md: Unsupported file type: text/plain'
  );
  expect(container.querySelector('output')?.textContent).toBe('selected.png');
  expect(input.value).toBe('');
  act(() => root.unmount());
  vi.unstubAllGlobals();
  container.remove();
});
