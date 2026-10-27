// @vitest-environment jsdom

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatReducer,
  createInitialChatState,
  type AcpConfigOption,
} from '@/client/features/chat/reducer';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { LeftControls } from './input-controls';

const mocks = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.mobile }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('capability-driven image upload controls', () => {
  it.each([
    { mobile: false, acp: true, attachments: true },
    { mobile: true, acp: true, attachments: true },
    { mobile: false, acp: false, attachments: true },
    { mobile: false, acp: true, attachments: false },
  ])(
    'honors upload capability (mobile=$mobile, ACP=$acp, attachments=$attachments)',
    ({ mobile, acp, attachments }) => {
      mocks.mobile = mobile;
      const fileInputRef = createRef<HTMLInputElement>();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        flushSync(() =>
          root.render(
            createElement(LeftControls, {
              capabilities: {
                ...EMPTY_CHAT_BAR_CAPABILITIES,
                attachments: { enabled: attachments, kinds: ['image'] },
              },
              acpConfigOptions: acp
                ? [
                    {
                      id: 'mode',
                      name: 'Mode',
                      type: 'select',
                      currentValue: 'default',
                      options: [{ value: 'default', name: 'Default' }],
                    },
                  ]
                : undefined,
              onSetConfigOption: vi.fn(),
              onModelChange: vi.fn(),
              onReasoningChange: vi.fn(),
              onThinkingChange: vi.fn(),
              onPlanModeChange: vi.fn(),
              running: false,
              disabled: false,
              modLabel: '⌘',
              modifierHeld: false,
              fileInputRef,
              onFileSelect: vi.fn(),
              supportedImageTypes: ['image/png'],
              onQuickAction: vi.fn(),
              quickActionsOpen: false,
              onQuickActionsOpenChange: vi.fn(),
            })
          )
        );
        const upload = container.querySelector<HTMLButtonElement>('[aria-label="Upload image"]');
        if (!attachments) {
          expect(upload).toBeNull();
          expect(fileInputRef.current).toBeNull();
          return;
        }
        expect(upload).not.toBeNull();
        expect(fileInputRef.current?.type).toBe('file');
        expect(fileInputRef.current?.accept).toBe('image/png');
        const openFilePicker = vi.spyOn(fileInputRef.current!, 'click');
        flushSync(() => upload?.click());
        expect(openFilePicker).toHaveBeenCalledOnce();
      } finally {
        flushSync(() => root.unmount());
        container.remove();
      }
    }
  );
});

const selectionCapabilities = {
  ...EMPTY_CHAT_BAR_CAPABILITIES,
  provider: 'CODEX' as const,
  model: { enabled: true, selected: 'six-sol', options: [{ value: 'six-sol', label: '6 Sol' }] },
  reasoning: { enabled: true, selected: 'high', options: [{ value: 'high', label: 'High' }] },
  thinking: { enabled: true },
  planMode: { enabled: true },
};

function renderSelectionControls(
  overrides: Partial<React.ComponentProps<typeof LeftControls>> = {}
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    capabilities: selectionCapabilities,
    acpConfigOptions: [
      {
        id: 'mode',
        name: 'Mode',
        type: 'select' as const,
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }],
      },
    ],
    onSetConfigOption: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onPlanModeChange: vi.fn(),
    running: false,
    disabled: false,
    modLabel: '⌘',
    modifierHeld: false,
    fileInputRef: createRef<HTMLInputElement>(),
    onFileSelect: vi.fn(),
    supportedImageTypes: ['image/png'],
    onQuickAction: vi.fn(),
    quickActionsOpen: false,
    onQuickActionsOpenChange: vi.fn(),
    ...overrides,
  };
  flushSync(() => root.render(createElement(LeftControls, props)));
  return { container, props, unmount: () => flushSync(() => root.unmount()) };
}

describe('provider and model selection', () => {
  it.each([false, true])(
    'keeps the selected model visible with mode-only ACP options (mobile=%s)',
    (mobile) => {
      mocks.mobile = mobile;
      const mounted = renderSelectionControls();
      try {
        expect(
          mounted.container.querySelector('[aria-label="Provider and model: Codex · 6 Sol"]')
        ).not.toBeNull();
        if (!mobile) {
          expect(
            mounted.container.querySelector('[aria-label="Toggle thinking mode"]')
          ).not.toBeNull();
          expect(
            mounted.container.querySelector('[aria-label="Toggle planning mode"]')
          ).not.toBeNull();
          expect(mounted.container.textContent).toContain('High');
        }
      } finally {
        mounted.unmount();
      }
    }
  );

  it.each([{ running: true }, { disabled: true }, { stopping: true }])(
    'disables selection while unavailable: %j',
    (overrides) => {
      mocks.mobile = false;
      const mounted = renderSelectionControls(overrides);
      try {
        expect(
          mounted.container.querySelector<HTMLButtonElement>(
            '[aria-label="Provider and model: Codex · 6 Sol"]'
          )?.disabled
        ).toBe(true);
        expect(
          mounted.container.querySelector<HTMLButtonElement>('[aria-label="Access: Default"]')
            ?.disabled
        ).toBe(true);
      } finally {
        mounted.unmount();
      }
    }
  );
});

it('uses the native model catalog and raw option ID without duplicating its selector', () => {
  mocks.mobile = false;
  const onSetConfigOption = vi.fn();
  const onModelChange = vi.fn();
  const mounted = renderSelectionControls({
    onSetConfigOption,
    onModelChange,
    acpConfigOptions: [
      {
        id: 'runtime-model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'native-sol',
        options: [
          {
            group: 'Available',
            options: [
              { value: 'native-sol', name: 'Native Sol' },
              { value: 'native-luna', name: 'Native Luna' },
            ],
          },
        ],
      },
    ],
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Codex · Native Sol"]'
    );
    expect(trigger).not.toBeNull();
    expect(mounted.container.querySelector('[aria-label="Model: Native Sol"]')).toBeNull();
    flushSync(() =>
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const luna = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent === 'Native Luna'
    );
    flushSync(() => luna?.click());
    expect(onSetConfigOption).toHaveBeenCalledWith('runtime-model', 'native-luna');
    expect(onModelChange).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
  }
});

it('keeps loading selection visible until capabilities resolve', () => {
  mocks.mobile = false;
  const mounted = renderSelectionControls({
    capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
    capabilitiesLoaded: false,
    acpConfigOptions: undefined,
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Loading model…"]'
    );
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.title).toContain('Loading');
  } finally {
    mounted.unmount();
  }
});

it('keeps the mobile picker outside runtime options and preserves fallback settings in the sheet', () => {
  mocks.mobile = true;
  const mounted = renderSelectionControls();
  try {
    const open = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Open chat options"]'
    );
    flushSync(() => open?.click());
    const sheet = document.body.querySelector('[data-testid="chat-options-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector('[aria-label^="Provider and model"]')).toBeNull();
    expect(sheet?.querySelector('[aria-label="Access: Default"]')).not.toBeNull();
    expect(sheet?.querySelector('[aria-label="Toggle thinking mode"]')).not.toBeNull();
    expect(sheet?.textContent).toContain('Reasoning');
  } finally {
    mounted.unmount();
  }
});

it('routes fallback capability model choices through settings when native model option is absent', () => {
  mocks.mobile = false;
  const onModelChange = vi.fn();
  const mounted = renderSelectionControls({
    onModelChange,
    capabilities: {
      ...selectionCapabilities,
      model: {
        ...selectionCapabilities.model,
        options: [...selectionCapabilities.model.options, { value: 'six-luna', label: '6 Luna' }],
      },
    },
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Codex · 6 Sol"]'
    );
    flushSync(() =>
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const luna = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent === '6 Luna'
    );
    flushSync(() => luna?.click());
    expect(onModelChange).toHaveBeenCalledWith('six-luna');
    expect(mounted.props.onSetConfigOption).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
  }
});

const rapidModelOption: AcpConfigOption = {
  id: 'runtime-model',
  category: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'six-sol',
  options: [
    { value: 'six-sol', name: '6 Sol' },
    { value: 'six-luna', name: '6 Luna' },
    { value: 'six-nova', name: '6 Nova' },
  ],
};

it.each([false, true])(
  'keeps the latest model visible through an older native acknowledgement (mobile=%s)',
  (mobile) => {
    mocks.mobile = mobile;
    let state = chatReducer(createInitialChatState(), {
      type: 'WS_CHAT_CAPABILITIES',
      payload: { capabilities: selectionCapabilities },
    });
    state = chatReducer(state, {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: { configOptions: [rapidModelOption] },
    });
    state = chatReducer(state, { type: 'UPDATE_SETTINGS', payload: { selectedModel: 'six-luna' } });
    state = chatReducer(state, { type: 'UPDATE_SETTINGS', payload: { selectedModel: 'six-nova' } });
    state = chatReducer(state, {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: { configOptions: [{ ...rapidModelOption, currentValue: 'six-luna' }] },
    });
    expect(state.chatSettings.selectedModel).toBe('six-nova');
    const onSetConfigOption = vi.fn();
    const mounted = renderSelectionControls({
      capabilities: state.chatCapabilities,
      settings: state.chatSettings,
      acpConfigOptions: state.acpConfigOptions,
      onSetConfigOption,
    });
    try {
      const trigger = mounted.container.querySelector<HTMLButtonElement>(
        '[aria-label="Provider and model: Codex · 6 Nova"]'
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.disabled).toBe(false);
      expect(trigger?.getAttribute('aria-busy')).toBe('true');
      flushSync(() =>
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
      );
      const nova = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (option) => option.textContent === '6 Nova'
      );
      expect(nova?.getAttribute('aria-checked')).toBe('true');
      flushSync(() => nova?.click());
      expect(onSetConfigOption).toHaveBeenCalledWith('runtime-model', 'six-nova');
    } finally {
      mounted.unmount();
    }
  }
);

it('keeps unsupported pending selections truthful while the native selection differs', () => {
  mocks.mobile = false;
  const mounted = renderSelectionControls({
    settings: { ...DEFAULT_CHAT_SETTINGS, selectedModel: 'custom-pending-model' },
    acpConfigOptions: [rapidModelOption],
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Codex · custom-pending-model"]'
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).not.toContain('6 Sol');
  } finally {
    mounted.unmount();
  }
});

it('hides bootstrap settings behind loading until provider capabilities resolve', () => {
  mocks.mobile = false;
  const mounted = renderSelectionControls({
    capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
    capabilitiesLoaded: false,
    settings: DEFAULT_CHAT_SETTINGS,
    acpConfigOptions: [rapidModelOption],
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Loading model…"]'
    );
    expect(trigger?.disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain('Opus');
    expect(trigger?.getAttribute('aria-busy')).toBe('false');
  } finally {
    mounted.unmount();
  }
});

it('shows unavailable selection after an empty capability response has finished loading', () => {
  mocks.mobile = false;
  const mounted = renderSelectionControls({
    capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
    capabilitiesLoaded: true,
    acpConfigOptions: undefined,
  });
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Provider and model: Claude · Select model"]'
    );
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.title).toContain('does not support model changes');
    expect(mounted.container.textContent).not.toContain('Loading');
  } finally {
    mounted.unmount();
  }
});
