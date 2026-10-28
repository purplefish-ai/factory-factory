// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLaunchControls, type SessionLaunchControlsProps } from './session-launch-controls';

const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  document.body.innerHTML = '';
});
function mount(overrides: Partial<SessionLaunchControlsProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props: SessionLaunchControlsProps = {
    provider: 'CODEX',
    model: 'sol',
    models: [{ value: 'sol', label: '6 Sol' }],
    onProviderChange: vi.fn(),
    onModelChange: vi.fn(),
    reasoning: {
      value: 'high',
      options: [
        { value: 'default', label: 'Default' },
        { value: 'high', label: 'High' },
        { value: 'ultra', label: 'Ultra' },
      ],
      defaultValue: 'default',
      loading: false,
      invalid: false,
      onChange: vi.fn(),
      onRetry: vi.fn(),
    },
    planMode: { enabled: false, supported: true, loading: false, onChange: vi.fn() },
    ...overrides,
  };
  flushSync(() => root.render(createElement(SessionLaunchControls, props)));
  return { container, props };
}
function keyboardOpen(button: HTMLButtonElement | null) {
  flushSync(() =>
    button?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
  );
}
function keyboardSelect(label: string) {
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === label
  );
  expect(item).toBeDefined();
  flushSync(() => {
    item?.focus();
    item?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });
}

describe('SessionLaunchControls', () => {
  it('selects advertised higher levels and native Default with the keyboard, without duplicate Default rows', () => {
    const mounted = mount();
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Thinking level: High"]'
    );
    keyboardOpen(trigger);
    expect(
      [...document.body.querySelectorAll('[role="menuitemradio"]')].filter(
        (option) => option.textContent === 'Default'
      )
    ).toHaveLength(1);
    keyboardSelect('Ultra');
    expect(mounted.props.reasoning?.onChange).toHaveBeenLastCalledWith('ultra');
    keyboardOpen(trigger);
    keyboardSelect('Default');
    expect(mounted.props.reasoning?.onChange).toHaveBeenLastCalledWith(null);
  });
  it('keeps unsupported levels visible and permits clearing unsupported selected Plan', () => {
    const onReasoningChange = vi.fn();
    const onPlanChange = vi.fn();
    const mounted = mount({
      reasoning: {
        value: 'ultra',
        options: [{ value: 'high', label: 'High' }],
        loading: false,
        invalid: true,
        onChange: onReasoningChange,
        onRetry: vi.fn(),
      },
      planMode: { enabled: true, supported: false, loading: false, onChange: onPlanChange },
    });
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Thinking level: ultra"]'
    );
    expect(trigger?.getAttribute('aria-invalid')).toBe('true');
    expect(trigger?.title).toContain('Choose a supported level or Default');
    keyboardOpen(trigger);
    keyboardSelect('Default');
    expect(onReasoningChange).toHaveBeenCalledWith(null);
    const plan = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Plan mode"]');
    expect(plan?.disabled).toBe(false);
    expect(plan?.hasAttribute('title')).toBe(false);
    expect(plan?.getAttribute('aria-description')).toContain('Turn Plan off to launch');
    expect(plan?.getAttribute('aria-pressed')).toBe('true');
    flushSync(() => plan?.click());
    expect(onPlanChange).toHaveBeenCalledWith(false);
  });
  it('offers discovery retry while leaving provider and model selection available', () => {
    const onRetry = vi.fn();
    const mounted = mount({
      reasoning: {
        options: [],
        loading: false,
        error: 'Could not load thinking options',
        invalid: false,
        onChange: vi.fn(),
        onRetry,
      },
      planMode: {
        enabled: false,
        supported: false,
        loading: false,
        error: 'Could not load planning options',
        onChange: vi.fn(),
      },
    });
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[aria-label^="Provider and model"]')
        ?.disabled
    ).toBe(false);
    keyboardOpen(mounted.container.querySelector('[aria-label="Thinking level: Unavailable"]'));
    const retry = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Retry thinking options'
    );
    flushSync(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[aria-label="Plan mode"]')?.disabled
    ).toBe(true);
  });
});
