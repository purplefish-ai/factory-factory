// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import { AcpConfigSelector } from './acp-config-selector';

const modelOption: AcpConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'sonnet',
  options: [
    { value: 'default', name: 'Default — Opus 4.8 (1M)' },
    { value: 'claude-fable-5[1m]', name: 'Fable 5' },
    { value: 'sonnet', name: 'Sonnet 5' },
  ],
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AcpConfigSelector', () => {
  it('renders model labels while selecting their raw ACP values', () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AcpConfigSelector, { configOption: modelOption, onSelect }));
    });

    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Sonnet 5')
    );
    expect(trigger?.textContent).toContain('Sonnet 5');

    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.textContent).toContain('Default — Opus 4.8 (1M)');
    expect(menu?.textContent).toContain('Fable 5');
    expect(menu?.textContent).toContain('Sonnet 5');
    expect(menu?.className).toContain('w-64');
    expect(menu?.className).toContain('max-w-[calc(100vw-2rem)]');

    const fableOption = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
    ).find((option) => option.textContent === 'Fable 5');
    expect(fableOption).toBeDefined();

    flushSync(() => {
      fableOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      fableOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith('model', 'claude-fable-5[1m]');

    root.unmount();
  });
});
