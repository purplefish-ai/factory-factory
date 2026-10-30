// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';

it('keeps a queued PR update below live thinking, then returns it to the transcript on delivery', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const update: ChatMessage = {
    id: 'pr-event-queued-test',
    source: 'user',
    order: 1,
    timestamp: '2026-10-28T00:00:00.000Z',
    text: 'PR update queued for the next turn',
  };
  const render = (queued: boolean) =>
    flushSync(() =>
      root.render(
        createElement(TranscriptRenderingFixture, {
          messages: [
            queued
              ? update
              : { ...update, source: 'agent', message: { type: 'pr_update', text: 'CI failed' } },
          ],
          queuedMessageIds: new Set(queued ? [update.id] : []),
          running: true,
          startingSession: false,
          loadingSession: false,
          latestThinking: 'Considering the implementation',
        })
      )
    );
  try {
    render(true);
    expect(container.textContent).toContain('Considering the implementation');
    expect(container.textContent?.match(/PR update/g)).toHaveLength(1);
    expect(container.textContent!.indexOf('Considering the implementation')).toBeLessThan(
      container.textContent!.indexOf('PR update')
    );
    expect(container.querySelector('details')).toBeNull();
    render(false);
    expect(container.textContent).toContain('Considering the implementation');
    expect(container.textContent?.match(/PR update/g)).toHaveLength(1);
    expect(container.textContent!.indexOf('PR update')).toBeLessThan(
      container.textContent!.indexOf('Considering the implementation')
    );
    expect(container.querySelector('details')).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});

it('shows one PR queue status until all updates settle, preserving individual outcomes and human messages', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const updates: ChatMessage[] = [
    {
      id: 'pr-event-first',
      source: 'user',
      order: 1,
      timestamp: '2026-10-28T00:00:00.000Z',
      text: 'PR update queued for the next turn',
    },
    {
      id: 'second-update',
      source: 'agent',
      order: 2,
      timestamp: '2026-10-28T00:00:01.000Z',
      message: { type: 'pr_update', text: 'Review feedback' },
    },
    {
      id: 'pr-event-third',
      source: 'user',
      order: 3,
      timestamp: '2026-10-28T00:00:02.000Z',
      text: 'PR update queued for the next turn',
    },
  ];
  const human: ChatMessage = {
    id: 'human',
    source: 'user',
    order: 4,
    timestamp: '2026-10-28T00:00:03.000Z',
    text: 'Please check the tests too',
  };
  const render = (settled: number) => {
    const states = ['delivered', 'failed', 'cancelled'] as const;
    flushSync(() =>
      root.render(
        createElement(TranscriptRenderingFixture, {
          messages: [
            ...updates.map((update, index): ChatMessage =>
              index < settled
                ? {
                    ...update,
                    source: 'agent',
                    message: {
                      type: 'pr_update',
                      text: `Update ${index + 1} details`,
                      prDeliveryState: states[index],
                    },
                  }
                : update
            ),
            human,
          ],
          queuedMessageIds: new Set([...updates.slice(settled).map(({ id }) => id), human.id]),
          running: true,
          startingSession: false,
          loadingSession: false,
          latestThinking: 'Checking the implementation',
        })
      )
    );
  };
  try {
    for (const settled of [0, 1, 2, 3]) {
      render(settled);
      expect(container.textContent?.match(/PR update · queued for next turn/g) ?? []).toHaveLength(
        settled < 3 ? 1 : 0
      );
      expect(container.textContent).toContain(human.text);
      expect(container.querySelectorAll('details')).toHaveLength(settled);
      if (settled < 3) {
        expect(container.textContent!.indexOf('Checking the implementation')).toBeLessThan(
          container.textContent!.indexOf('PR update · queued for next turn')
        );
      }
      if (settled > 0) {
        expect(container.textContent).toContain('PR update · delivered');
      }
      if (settled > 1) {
        expect(container.textContent).toContain('PR update · failed');
      }
      if (settled > 2) {
        expect(container.textContent).toContain('PR update · cancelled');
      }
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
