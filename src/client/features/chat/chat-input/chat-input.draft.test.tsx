// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { ChatInput } from './chat-input';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('ChatInput drafts', () => {
  function setup(value?: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = trpc.createClient({ links: [] });
    const onChange = vi.fn();
    const onSend = vi.fn();
    const render = async (draft?: string, placeholder = 'Message') => {
      await act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <trpc.Provider client={client} queryClient={queryClient}>
              <ChatInput
                value={draft}
                onChange={onChange}
                onSend={onSend}
                placeholder={placeholder}
              />
            </trpc.Provider>
          </QueryClientProvider>
        )
      );
    };
    const textarea = () => {
      const element = container.querySelector('textarea');
      if (!element) {
        throw new Error('Missing composer textarea');
      }
      return element;
    };
    const type = async (suffix: string) => {
      const element = textarea();
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!;
      await act(() => {
        setValue.call(element, element.value + suffix);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    return {
      render,
      textarea,
      type,
      onChange,
      mount: () => render(value),
      cleanup: async () => {
        await act(() => root.unmount());
        queryClient.clear();
        container.remove();
      },
    };
  }

  it('shows a saved draft on first mount and keeps it when typing begins', async () => {
    const view = setup('A restored unsent draft');
    try {
      await view.mount();
      expect(view.textarea().value).toBe('A restored unsent draft');
      expect(view.onChange).not.toHaveBeenCalled();
      await view.type('!');
      expect(view.textarea().value).toBe('A restored unsent draft!');
      expect(view.onChange).toHaveBeenLastCalledWith('A restored unsent draft!');
    } finally {
      await view.cleanup();
    }
  });

  it('preserves local edits on unrelated renders and applies changed or cleared drafts', async () => {
    const view = setup('Saved draft');
    try {
      await view.mount();
      await view.type(' edited');
      await view.render('Saved draft', 'Updated placeholder');
      expect(view.textarea().value).toBe('Saved draft edited');
      await view.render('Another session draft');
      expect(view.textarea().value).toBe('Another session draft');
      await view.render('');
      expect(view.textarea().value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('allows typing without a draft prop', async () => {
    const view = setup();
    try {
      await view.mount();
      await view.type('New message');
      await view.render(undefined, 'Updated placeholder');
      expect(view.textarea().value).toBe('New message');
      expect(view.onChange).toHaveBeenLastCalledWith('New message');
    } finally {
      await view.cleanup();
    }
  });
});
