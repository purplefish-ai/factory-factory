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
  const option = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent === text
  );
  expect(option).toBeDefined();
  flushSync(() => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('ProviderModelPicker', () => {
  it('keeps an unknown model truthful instead of claiming the first catalog model', () => {
    const { trigger } = mount({ model: 'custom-model' });
    expect(trigger.textContent).toContain('Codex · custom-model');
    expect(trigger.textContent).not.toContain('6 Sol');
  });
  it('allows keyboard access to model choices while keeping the conversation provider fixed', () => {
    const { trigger, props } = mount();
    const menu = open(trigger);
    expect(menu).not.toBeNull();
    expect(menu.textContent).not.toContain('Claude');
    choose(menu, '6 Luna');
    expect(props.onModelChange).toHaveBeenCalledWith('six-luna');
  });
  it('offers a provider change only for a new conversation', () => {
    const onProviderChange = vi.fn();
    const { trigger } = mount({ onProviderChange });
    const menu = open(trigger);
    expect(menu.textContent).toContain('Provider for new conversation');
    choose(menu, 'Claude');
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE');
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
    choose(menu, 'Claude');
    expect(onProviderChange).toHaveBeenCalledWith('CLAUDE');
  });
});
