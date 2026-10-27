// @vitest-environment jsdom
import { composeStories } from '@storybook/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as stories from './inline-workspace-form.stories';

const { SavedCodexDefaults } = composeStories(stories);
it('updates provider and loading preview state when Storybook Controls change args', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (args: {
    provider: 'CLAUDE' | 'CODEX';
    loading?: boolean;
    catalogLoading?: boolean;
  }) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <SavedCodexDefaults {...args} />
        </TooltipProvider>
      )
    );
  try {
    await render({ provider: 'CODEX' });
    await vi.waitFor(() =>
      expect(
        container.querySelector('[aria-label="New conversation provider and model: Codex · 6 Sol"]')
      ).not.toBeNull()
    );
    await render({ provider: 'CLAUDE' });
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[aria-label="New conversation provider and model: Claude · Sonnet"]'
        )
      ).not.toBeNull()
    );
    await render({ provider: 'CLAUDE', loading: true });
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="New conversation provider and model: Loading model…"]'
        )?.disabled
      ).toBe(true)
    );
    await render({ provider: 'CODEX', catalogLoading: true });
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[aria-label="New conversation provider and model: Codex · six-sol"]'
        )
      ).not.toBeNull()
    );
    const picker = container.querySelector<HTMLButtonElement>(
      '[aria-label="New conversation provider and model: Codex · six-sol"]'
    );
    await act(() =>
      picker?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('Loading models');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('allows opening the real launch menu and switching to periodic mode before chat defaults finish loading', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <SavedCodexDefaults loading />
        </TooltipProvider>
      )
    );
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[aria-label="New conversation provider and model: Loading model…"]'
        )
      ).not.toBeNull()
    );
    const modeTrigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Choose launch mode"]'
    );
    expect(modeTrigger?.disabled).toBe(false);
    await act(() =>
      modeTrigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const periodic = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Create Periodic Task'
    );
    expect(periodic).toBeDefined();
    await act(() => periodic?.click());
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Create Periodic Task'
      )?.disabled
    ).toBe(false);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
