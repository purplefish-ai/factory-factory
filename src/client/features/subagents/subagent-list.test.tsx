// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentList, type SubagentListState } from './subagent-list';
import type { SubagentListItem } from './types';

function subagent(
  overrides: Partial<SubagentListItem> & Pick<SubagentListItem, 'id'>
): SubagentListItem {
  return {
    name: 'Provider name',
    status: 'running',
    createdAt: '2026-08-08T11:50:00.000Z',
    updatedAt: '2026-08-08T11:59:00.000Z',
    completedAt: null,
    latestActivity: 'Working',
    resultPreview: null,
    ...overrides,
  };
}

describe('SubagentList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  function render(props: Parameters<typeof SubagentList>[0]) {
    void act(() => root.render(createElement(SubagentList, props)));
  }

  it('sorts active sub-agents oldest first and keeps terminal results collapsed', () => {
    render({
      state: {
        kind: 'ready',
        subagents: [
          subagent({
            id: 'active-new',
            name: null,
            status: 'starting',
            createdAt: '2026-08-08T11:55:00.000Z',
            latestActivity: 'Preparing context',
          }),
          subagent({
            id: 'terminal-old',
            name: 'Finished audit',
            status: 'completed',
            createdAt: '2026-08-08T11:00:00.000Z',
            completedAt: '2026-08-08T11:45:00.000Z',
            updatedAt: '2026-08-08T11:45:00.000Z',
            latestActivity: null,
            resultPreview: 'No vulnerabilities found',
          }),
          subagent({
            id: 'active-old',
            name: 'Security review',
            status: 'running',
            createdAt: '2026-08-08T11:50:00.000Z',
            latestActivity: 'Checking auth paths',
          }),
          subagent({
            id: 'terminal-new',
            name: 'Broken checks',
            status: 'failed',
            createdAt: '2026-08-08T11:20:00.000Z',
            completedAt: null,
            updatedAt: '2026-08-08T11:50:00.000Z',
            latestActivity: 'Tests stopped',
            resultPreview: 'Timed out',
          }),
        ],
      },
      onSelect: vi.fn(),
    });

    const text = container.textContent ?? '';
    expect(text.indexOf('Security review')).toBeLessThan(text.indexOf('Sub-agent active-n'));
    expect(text).toContain('Running');
    expect(text).toContain('Starting');
    expect(text).toContain('10m elapsed');
    expect(text).toContain('Checking auth paths');
    expect(text).not.toContain('Finished audit');
    expect(text).not.toContain('Broken checks');

    const completedButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Completed · 2'
    );
    expect(completedButton?.getAttribute('aria-expanded')).toBe('false');

    void act(() => completedButton?.click());

    const expandedText = container.textContent ?? '';
    expect(expandedText.indexOf('Broken checks')).toBeLessThan(
      expandedText.indexOf('Finished audit')
    );
    expect(expandedText).toContain('Failed');
    expect(expandedText).toContain('Completed');
    expect(expandedText).toContain('Timed out');
    expect(expandedText).toContain('No vulnerabilities found');
    expect(expandedText).toContain('30m elapsed');
  });

  it('selects rows and exposes the selected row state', () => {
    const onSelect = vi.fn();
    const item = subagent({ id: 'child-1', name: 'Investigate cache' });
    render({
      state: { kind: 'ready', subagents: [item] },
      selectedSubagentId: 'child-1',
      onSelect,
    });

    const row = container.querySelector('button[aria-pressed="true"]');
    expect(row?.textContent).toContain('Investigate cache');
    void act(() => (row as HTMLButtonElement | null)?.click());
    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it('does not invent an increasing elapsed time for terminal rows without an end timestamp', () => {
    const props = {
      state: {
        kind: 'ready' as const,
        subagents: [
          subagent({
            id: 'terminal-without-end',
            name: 'Finished without timestamps',
            status: 'completed',
            updatedAt: null,
            completedAt: null,
          }),
        ],
      },
      onSelect: vi.fn(),
    };
    render(props);

    const completedButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Completed · 1'
    );
    void act(() => completedButton?.click());

    expect(container.textContent).toContain('Finished without timestamps');
    expect(container.textContent).not.toContain('elapsed');

    vi.advanceTimersByTime(5 * 60 * 1000);
    render(props);
    expect(container.textContent).not.toContain('elapsed');
  });

  it('keeps active elapsed time current without provider notifications', () => {
    render({
      state: {
        kind: 'ready',
        subagents: [
          subagent({
            id: 'active-timer',
            name: 'Long-running review',
            createdAt: '2026-08-08T11:59:50.000Z',
          }),
        ],
      },
      onSelect: vi.fn(),
    });
    expect(container.textContent).toContain('10s elapsed');

    void act(() => vi.advanceTimersByTime(5000));

    expect(container.textContent).toContain('15s elapsed');
  });

  it.each<[string, SubagentListState, string]>([
    ['loading', { kind: 'loading' }, 'Loading sub-agents…'],
    ['empty', { kind: 'ready', subagents: [] }, 'No sub-agents for this session.'],
  ])('renders the %s state', (_name, state, expectedText) => {
    render({ state, onSelect: vi.fn() });
    expect(container.textContent).toContain(expectedText);
  });

  it('contains list errors and exposes retry', () => {
    const onRetry = vi.fn();
    render({
      state: { kind: 'error', message: 'Provider unavailable', onRetry },
      onSelect: vi.fn(),
    });

    expect(container.textContent).toContain('Provider unavailable');
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders nothing for unsupported providers', () => {
    render({ state: { kind: 'unsupported' }, onSelect: vi.fn() });
    expect(container.innerHTML).toBe('');
  });
});
