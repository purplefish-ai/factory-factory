// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, ErrorFallback, formatErrorDetails } from './error-boundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ThrowUnknown({ value }: { value: unknown }): never {
  throw value;
}

let shouldThrow = true;
function Crashy({ label = 'content' }: { label?: string }) {
  if (shouldThrow) {
    throw new Error('Cannot read properties of undefined');
  }
  return <p>{label}</p>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  shouldThrow = true;
  vi.stubGlobal('reportError', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container, {
    onCaughtError: () => undefined,
    onUncaughtError: () => undefined,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function buttonNamed(name: string) {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(name)
  );
}

describe('ErrorBoundary', () => {
  it('reports a first crash only once when navigation also changes the reset key', () => {
    shouldThrow = false;
    act(() =>
      root.render(
        <ErrorBoundary resetKey="healthy">
          <Crashy />
        </ErrorBoundary>
      )
    );
    shouldThrow = true;
    act(() =>
      root.render(
        <ErrorBoundary resetKey="broken">
          <Crashy />
        </ErrorBoundary>
      )
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(globalThis.reportError).toHaveBeenCalledOnce();
  });
  it.each(['a thrown string', { reason: 'a thrown object' }, null, undefined])(
    'keeps recovery actions available for a non-Error throw: %s',
    async (thrown) => {
      await act(async () =>
        root.render(
          <ErrorBoundary>
            <ThrowUnknown value={thrown} />
          </ErrorBoundary>
        )
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't show this page"
      );
      expect(buttonNamed('Reload')).toBeDefined();
      expect(buttonNamed('Copy details')).toBeDefined();
      expect(globalThis.reportError).toHaveBeenCalledOnce();
    }
  );

  it('shows a page fallback with Reload and Copy details but no retry by default', () => {
    act(() =>
      root.render(
        <ErrorBoundary>
          <Crashy />
        </ErrorBoundary>
      )
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't show this page");
    expect(alert?.textContent).toContain('Cannot read properties of undefined');
    expect(buttonNamed('Reload')).toBeDefined();
    expect(buttonNamed('Copy details')).toBeDefined();
    expect(buttonNamed('Try again')).toBeUndefined();
    expect(alert?.className).not.toContain('min-h-screen');
    expect(globalThis.reportError).toHaveBeenCalledOnce();
  });

  it('renders a compact fallback with a custom title for panels', () => {
    act(() =>
      root.render(
        <ErrorBoundary variant="compact" title="Couldn't load the viewer">
          <Crashy />
        </ErrorBoundary>
      )
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load the viewer");
    expect(alert?.querySelector('h2')).toBeNull();
  });

  it('re-renders the children on Try again when retry is offered', () => {
    act(() =>
      root.render(
        <ErrorBoundary showRetry>
          <Crashy />
        </ErrorBoundary>
      )
    );
    shouldThrow = false;
    act(() => buttonNamed('Try again')?.click());
    expect(container.textContent).toBe('content');
  });

  it('resets when the reset key changes after a crash', () => {
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/projects/a">
          <Crashy label="page a" />
        </ErrorBoundary>
      )
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    shouldThrow = false;
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/projects/b">
          <Crashy label="page b" />
        </ErrorBoundary>
      )
    );
    expect(container.textContent).toBe('page b');
  });

  it('uses a custom fallback when given', () => {
    act(() =>
      root.render(
        <ErrorBoundary fallback={<p>Custom fallback</p>}>
          <Crashy />
        </ErrorBoundary>
      )
    );
    expect(container.textContent).toBe('Custom fallback');
  });
});

describe('ErrorFallback', () => {
  it('reloads and copies the error details', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onReload = vi.fn();
    const error = new Error('Boom');
    act(() =>
      root.render(
        <ErrorFallback error={error} componentStack={'\n    at Panel'} onReload={onReload} />
      )
    );
    act(() => buttonNamed('Reload')?.click());
    expect(onReload).toHaveBeenCalledOnce();

    await act(async () => {
      buttonNamed('Copy details')?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledOnce();
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain('Error: Boom');
    expect(copied).toContain('Component stack:\nat Panel');
    expect(buttonNamed('Copied')).toBeDefined();
  });

  it('reports a clipboard failure on the button', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    act(() => root.render(<ErrorFallback error={new Error('Boom')} />));
    await act(async () => {
      buttonNamed('Copy details')?.click();
      await Promise.resolve();
    });
    expect(buttonNamed("Couldn't copy")).toBeDefined();
  });
});

describe('formatErrorDetails', () => {
  it('includes the message, context, stack and component trace', () => {
    const error = new TypeError('x is undefined');
    error.stack = 'TypeError: x is undefined\n    at render (panel.tsx:1:1)';
    const details = formatErrorDetails(error, '\n    at Panel\n    at Layout', {
      url: 'http://localhost/projects/demo',
      userAgent: 'test-agent',
      time: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(details).toBe(
      [
        'TypeError: x is undefined',
        '',
        'URL: http://localhost/projects/demo',
        'Time: 2026-01-02T03:04:05.000Z',
        'User agent: test-agent',
        '',
        'Stack:',
        'TypeError: x is undefined\n    at render (panel.tsx:1:1)',
        '',
        'Component stack:',
        'at Panel\n    at Layout',
      ].join('\n')
    );
  });

  it('omits empty stack sections', () => {
    const error = new Error('plain');
    error.stack = undefined;
    const details = formatErrorDetails(error, null, {
      url: 'u',
      userAgent: 'a',
      time: new Date(0),
    });
    expect(details).not.toContain('Stack:');
    expect(details).not.toContain('Component stack:');
  });
});
