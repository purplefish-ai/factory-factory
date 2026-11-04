// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiUsageSection, type ApiUsageSectionProps } from './ApiUsageSection';

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    onOpenChange,
    onConfirm,
    isPending,
  }: {
    open: boolean;
    title: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    isPending?: boolean;
  }) =>
    open
      ? createElement(
          'div',
          { role: 'alertdialog', 'aria-label': title },
          createElement(
            'button',
            { type: 'button', 'data-testid': 'confirm', onClick: onConfirm, disabled: isPending },
            'Reset'
          ),
          createElement(
            'button',
            { type: 'button', 'data-testid': 'cancel', onClick: () => onOpenChange(false) },
            'Cancel'
          )
        )
      : null,
}));

afterEach(() => {
  document.body.innerHTML = '';
});

function renderSection(props: Partial<ApiUsageSectionProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onReset = props.onReset ?? vi.fn(() => Promise.resolve());
  const render = (overrides: Partial<ApiUsageSectionProps> = {}) =>
    flushSync(() =>
      root.render(
        createElement(ApiUsageSection, { isResetting: false, ...props, onReset, ...overrides })
      )
    );
  render();
  return { container, root, onReset, render };
}

function clickResetStats(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === 'Reset Stats'
  );
  flushSync(() => button?.click());
}

function dialog(container: HTMLElement) {
  return container.querySelector('[role="alertdialog"]');
}

describe('ApiUsageSection reset confirmation', () => {
  it('asks before resetting and does nothing on cancel', () => {
    const { container, root, onReset } = renderSection();

    clickResetStats(container);
    expect(dialog(container)?.getAttribute('aria-label')).toBe('Reset API usage stats?');

    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="cancel"]')?.click());
    expect(dialog(container)).toBeNull();
    expect(onReset).not.toHaveBeenCalled();

    root.unmount();
  });

  it('closes after a successful reset', async () => {
    const { container, root, onReset } = renderSection();

    clickResetStats(container);
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click());

    expect(onReset).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dialog(container)).toBeNull());

    root.unmount();
  });

  it('stays open after a failed reset and while the reset is pending', async () => {
    const onReset = vi.fn(() => Promise.reject(new Error('Rate limiter offline')));
    const { container, root, render } = renderSection({ onReset });

    clickResetStats(container);
    render({ isResetting: true });
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="cancel"]')?.click());
    expect(dialog(container)).not.toBeNull();

    render({ isResetting: false });
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click());
    await Promise.resolve();
    await Promise.resolve();
    expect(onReset).toHaveBeenCalledOnce();
    expect(dialog(container)).not.toBeNull();

    root.unmount();
  });
});
