// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderModelPicker, type ProviderModelPickerProps } from './provider-model-picker';

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    flushSync(() => root.unmount());
  }
  document.body.innerHTML = '';
});
function mount(overrides: Partial<ProviderModelPickerProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props: ProviderModelPickerProps = {
    provider: 'CODEX',
    model: 'six-sol',
    models: [
      { value: 'six-sol', label: '6 Sol' },
      { value: 'six-luna', label: '6 Luna' },
    ],
    onModelChange: vi.fn(),
    providerOptions: {
      CLAUDE: {
        defaultModel: 'sonnet',
        models: [
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
        ],
      },
      CODEX: { defaultModel: 'six-sol', models: [{ value: 'six-sol', label: '6 Sol' }] },
    },
    ...overrides,
  };
  flushSync(() => root.render(createElement(ProviderModelPicker, props)));
  const trigger = container.querySelector<HTMLButtonElement>('button')!;
  return { trigger, props };
}
function open(trigger: HTMLButtonElement) {
  flushSync(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
  );
  return document.body.querySelector<HTMLElement>('[role="menu"]')!;
}
function choose(menu: HTMLElement, text: string) {
  const option = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.startsWith(text)
  );
  expect(option).toBeDefined();
  flushSync(() => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
function findProvider(menu: HTMLElement, name: string) {
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((option) =>
    option.textContent?.startsWith(name)
  );
  expect(item).toBeDefined();
  return item!;
}

describe('ProviderModelPicker', () => {
  it.each([
    { provider: 'CLAUDE' as const, model: 'sonnet', label: 'Sonnet' },
    { provider: 'CODEX' as const, model: 'six-sol', label: '6 Sol' },
  ])('previews only the model for $provider', ({ provider, model, label }) => {
    const { trigger } = mount({ provider, model, models: [{ value: model, label }] });
    expect(trigger.textContent).toBe(label);
  });
  it('keeps an unknown model truthful instead of claiming the first catalog model', () => {
    const { trigger } = mount({ model: 'custom-model' });
    expect(trigger.textContent).toBe('custom-model');
    expect(trigger.textContent).not.toContain('6 Sol');
  });
  it('allows keyboard access to model choices while keeping the conversation provider fixed', () => {
    const { trigger, props } = mount();
    const menu = open(trigger);
    expect(menu).not.toBeNull();
    expect(menu.textContent).not.toContain('Claude');
    const luna = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (option) => option.textContent === '6 Luna'
    );
    flushSync(() => {
      luna?.focus();
      luna?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(props.onModelChange).toHaveBeenCalledWith('six-luna');
  });
  it('offers a provider change only for a new conversation', () => {
    const onProviderChange = vi.fn();
    const { trigger } = mount({ onProviderChange });
    const menu = open(trigger);
    expect(menu.textContent).not.toContain('6 Luna');
    flushSync(() => findProvider(menu, 'Claude').click());
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE', 'sonnet');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
  it('selects a model from another provider in one menu visit', () => {
    const onProviderChange = vi.fn();
    const { trigger, props } = mount({ onProviderChange });
    const menu = open(trigger);
    const claude = findProvider(menu, 'Claude');
    flushSync(() => {
      claude.focus();
      claude.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    const submenu =
      document.body.querySelector<HTMLElement>('[role="menu"][data-state="open"] [role="menu"]') ??
      [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')].at(-1)!;
    choose(submenu, 'Opus');
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE', 'opus');
    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
  it('selects the provider default with Enter rather than opening its submenu', () => {
    const onProviderChange = vi.fn();
    const { trigger } = mount({ onProviderChange });
    const claude = findProvider(open(trigger), 'Claude');
    flushSync(() => {
      claude.focus();
      claude.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE', 'sonnet');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
  it('opens the models using the chevron without selecting the provider', () => {
    const onProviderChange = vi.fn();
    const { trigger } = mount({ onProviderChange });
    const claude = findProvider(open(trigger), 'Claude');
    const chevron = claude.querySelector<HTMLElement>('[data-model-submenu]');
    expect(chevron).not.toBeNull();
    flushSync(() => chevron?.click());
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Claude models');
  });
  it.each([
    { loading: true, disabledReason: 'Connecting to session' },
    { disabled: true, disabledReason: 'Agent is running' },
  ])('explains unavailable selection: %j', (props) => {
    const { trigger } = mount(props);
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('title')).toBe(props.disabledReason);
    expect(trigger.getAttribute('aria-description')).toBe(props.disabledReason);
    if (props.loading) {
      expect(trigger.textContent).toContain('Loading model');
    }
  });
  it('keeps provider selection available while its model catalog loads', () => {
    const onProviderChange = vi.fn();
    const { trigger } = mount({ models: [], modelsLoading: true, onProviderChange });
    expect(trigger.disabled).toBe(false);
    const menu = open(trigger);
    expect(menu.textContent).toContain('Loading models');
    flushSync(() => findProvider(menu, 'Claude').click());
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE', 'sonnet');
  });
});

it('shows a compact retry action when selection defaults cannot load', () => {
  const onRetry = vi.fn();
  const { trigger } = mount({
    provider: null,
    model: undefined,
    models: [],
    error: 'Could not load chat defaults',
    onRetry,
  });
  expect(trigger.textContent).toContain('Retry selection');
  expect(trigger.disabled).toBe(false);
  expect(trigger.title).toBe('Could not load chat defaults');
  flushSync(() => trigger.click());
  expect(onRetry).toHaveBeenCalledOnce();
});

it('explains why an error retry is disabled while keeping its loading failure accessible', () => {
  const { trigger } = mount({
    error: 'Could not load chat defaults',
    onRetry: vi.fn(),
    disabled: true,
    disabledReason: 'Maximum 3 sessions per workspace',
  });
  expect(trigger.disabled).toBe(true);
  expect(trigger.getAttribute('aria-description')).toBe('Maximum 3 sessions per workspace');
  expect(trigger.getAttribute('aria-label')).toContain('Could not load chat defaults');
  expect(trigger.title).toContain('Maximum 3 sessions per workspace');
});

it('clears an obsolete disabled reason when retry becomes available', () => {
  const { trigger } = mount({
    error: 'Could not load chat defaults',
    onRetry: vi.fn(),
    disabled: false,
    disabledReason: 'Maximum 3 sessions per workspace',
  });
  expect(trigger.disabled).toBe(false);
  expect(trigger.title).toBe('Could not load chat defaults');
  expect(trigger.getAttribute('aria-description')).toBeNull();
});
