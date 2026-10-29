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
  it.each([
    ['mode', 'Access', 'workspace-write', 'Workspace access'],
    ['collaboration_mode', 'Planning', 'plan', 'Plan'],
  ])('labels native %s controls independently', (id, label, value, name) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        createElement(AcpConfigSelector, {
          configOption: {
            id,
            name: 'Mode',
            type: 'select',
            currentValue: value,
            options: [{ value, name }],
          },
          onSelect: vi.fn(),
        })
      )
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(`${label}: ${name}`);
    root.unmount();
  });

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

it.each([['mode', 'Access', 'acceptEdits', 'Accept edits']])(
  'makes %s compact without losing its accessible name or selected value',
  (id, label, value, name) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    flushSync(() =>
      root.render(
        createElement(AcpConfigSelector, {
          configOption: {
            id,
            name: label,
            type: 'select',
            currentValue: value,
            description: 'How this setting works',
            options: [
              { value, name, description: 'Current behavior' },
              { value: 'other', name: 'Another choice', description: 'Another behavior' },
            ],
          },
          onSelect,
        })
      )
    );
    try {
      const trigger = container.querySelector('button');
      expect(trigger?.getAttribute('aria-label')).toBe(`${label}: ${name}`);
      expect(trigger?.textContent).toBe('');
      flushSync(() =>
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
      );
      const menu = document.body.querySelector('[role="menu"]');
      expect(menu?.textContent).toContain('How this setting works');
      expect(menu?.textContent).toContain('Current behavior');
      expect(menu?.querySelector('[aria-checked="true"]')?.textContent).toContain(name);
      const other = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].find(
        (item) => item.textContent?.includes('Another choice')
      );
      flushSync(() => other?.click());
      expect(onSelect).toHaveBeenCalledWith(id, 'other');
    } finally {
      flushSync(() => root.unmount());
    }
  }
);

it('shows descriptions and selects raw values in grouped provider options', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  flushSync(() =>
    root.render(
      createElement(AcpConfigSelector, {
        configOption: {
          id: 'custom',
          name: 'Custom setting',
          type: 'select',
          currentValue: 'first',
          options: [
            {
              group: 'Available',
              options: [
                { value: 'first', name: 'First' },
                { value: 'raw-value', name: 'Second', description: 'Provider explanation' },
              ],
            },
          ],
        },
        onSelect,
      })
    )
  );
  try {
    const trigger = container.querySelector('button');
    flushSync(() =>
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes('Second')
    );
    expect(item?.textContent).toContain('Provider explanation');
    flushSync(() => item?.click());
    expect(onSelect).toHaveBeenCalledWith('custom', 'raw-value');
  } finally {
    flushSync(() => root.unmount());
  }
});

it.each([
  'agent-full-access',
  'bypassPermissions',
  'dangerouslySkipPermissions',
  'dangerousSkipPermissions',
])('warns about unrestricted access in both trigger and menu for %s', (value) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      createElement(AcpConfigSelector, {
        configOption: {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: value,
          options: [
            { value, name: 'Unrestricted' },
            { value: 'default', name: 'Manual' },
          ],
        },
        onSelect: vi.fn(),
      })
    )
  );
  try {
    const trigger = container.querySelector('button');
    expect(trigger?.className).toContain('text-orange-600');
    flushSync(() =>
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const selected = document.body.querySelector('[role="menuitemradio"][aria-checked="true"]');
    expect(selected?.className).toContain('text-orange-600');
    const manual = document.body.querySelector('[role="menuitemradio"][aria-checked="false"]');
    expect(manual?.className).not.toContain('text-orange-600');
  } finally {
    flushSync(() => root.unmount());
  }
});

it.each([
  ['collaboration_mode', undefined, 'default', 'plan', 'Planning'],
  ['plan_mode', undefined, 'default', 'plan', 'Planning'],
  ['fast-mode', undefined, 'off', 'on', 'Fast mode'],
  ['fast', undefined, 'off', 'on', 'Fast mode'],
  ['ultracode', 'model_config', 'off', 'on', 'Setting'],
  ['provider-feature', 'model_config', 'off', 'on', 'Setting'],
  ['provider-planning', 'plan_mode', 'default', 'plan', 'Planning'],
  ['provider-speed', 'fast', 'off', 'on', 'Fast mode'],
])('toggles %s directly in both directions', (id, category, off, on, label) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const render = (value: string, disabled = false, compact = true) =>
    flushSync(() =>
      root.render(
        createElement(AcpConfigSelector, {
          configOption: {
            id,
            category,
            name: 'Setting',
            type: 'select',
            currentValue: value,
            options: [
              {
                group: 'Modes',
                options: [
                  { value: off, name: 'Off' },
                  { value: on, name: 'On' },
                ],
              },
            ],
          },
          onSelect,
          disabled,
          compact,
        })
      )
    );
  try {
    render(off);
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe(`${label}: Off`);
    expect(button?.textContent).toBe('');
    flushSync(() => button?.click());
    expect(onSelect).toHaveBeenLastCalledWith(id, on);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(button?.hasAttribute('aria-haspopup')).toBe(false);

    render(on, false, false);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe(`${label}: On`);
    expect(button?.textContent).toBe('On');
    flushSync(() => button?.click());
    expect(onSelect).toHaveBeenLastCalledWith(id, off);

    onSelect.mockClear();
    render(off, true);
    flushSync(() => button?.click());
    expect(onSelect).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
  }
});

it.each([
  ['collaboration_mode', 'plan', 'default'],
  ['fast-mode', 'on', 'off'],
  ['ultracode', 'on', 'off'],
])('allows clearing an unsupported selected %s value', (id, selected, fallback) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const render = (options: AcpConfigOption['options']) =>
    flushSync(() =>
      root.render(
        createElement(AcpConfigSelector, {
          configOption: { id, name: 'Setting', type: 'select', currentValue: selected, options },
          onSelect,
        })
      )
    );
  try {
    render([{ value: fallback, name: 'Default' }]);
    const button = container.querySelector('button');
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    flushSync(() => button?.click());
    expect(onSelect).toHaveBeenCalledWith(id, fallback);

    onSelect.mockClear();
    render([{ value: selected, name: 'Selected' }]);
    expect(button?.disabled).toBe(true);
    flushSync(() => button?.click());
    expect(onSelect).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
  }
});

it.each([{ options: [] }, { options: [{ group: 'Unavailable', options: [] }] }])(
  'does not present an unavailable provider setting as a toggle (%j)',
  ({ options }) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    flushSync(() =>
      root.render(
        createElement(AcpConfigSelector, {
          configOption: {
            id: 'ultracode',
            name: 'Ultracode',
            type: 'select',
            currentValue: 'on',
            options,
          },
          onSelect,
        })
      )
    );
    try {
      const button = container.querySelector('button');
      expect(button?.hasAttribute('aria-pressed')).toBe(false);
      expect(button?.textContent).toBe('on');
      flushSync(() => button?.click());
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
