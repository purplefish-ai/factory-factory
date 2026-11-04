// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentErrorStrip } from './agent-error-strip';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.clearAllMocks();
});

function button(name: string) {
  return [...container.querySelectorAll('button')].find(
    (element) => element.textContent === name || element.getAttribute('aria-label') === name
  );
}

describe('AgentErrorStrip', () => {
  it('announces the full error and offers only the provided actions', () => {
    const onRestart = vi.fn();
    const message = `Provider error: ${'stack frame\n'.repeat(30)}`;
    flushSync(() => root.render(<AgentErrorStrip message={message} onRestart={onRestart} />));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Agent error');
    expect(alert?.textContent).toContain(message);
    expect(alert?.querySelector('p:last-child')?.className).toContain('overflow-y-auto');
    expect(button('Retry')).toBeUndefined();
    expect(button('Dismiss error')).toBeUndefined();
    flushSync(() => button('Restart agent')?.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('copies the error and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    flushSync(() => root.render(<AgentErrorStrip message="Request timed out" />));

    flushSync(() => button('Copy error')?.click());

    await vi.waitFor(() => expect(button('Copied')).toBeDefined());
    expect(writeText).toHaveBeenCalledWith('Request timed out');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Error copied to the clipboard'
    );
  });

  it('reports clipboard failures', async () => {
    flushSync(() => root.render(<AgentErrorStrip message="Request timed out" />));

    flushSync(() => button('Copy error')?.click());

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't copy to the clipboard")
    );
    expect(button('Copy error')).toBeDefined();
  });
});
