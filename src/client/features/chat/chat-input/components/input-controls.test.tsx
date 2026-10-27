// @vitest-environment jsdom

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
