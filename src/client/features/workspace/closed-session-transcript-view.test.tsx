import type { inferRouterOutputs } from '@trpc/server';
// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRouter } from '@/client/lib/trpc';
import { ArchivedJsonValueSchema } from '@/shared/acp-protocol/protocol/archived-content-schema';

type Transcript = inferRouterOutputs<AppRouter>['closedSessions']['getTranscript'];
const query = vi.hoisted(() => ({ data: undefined as Transcript | undefined, isLoading: false }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { closedSessions: { getTranscript: { useQuery: () => query } } },
}));
import { ClosedSessionTranscriptView } from './closed-session-transcript-view';

let mounted: Root | undefined;
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
  query.data = undefined;
  query.isLoading = false;
});
function render(messages?: unknown[]) {
  query.data = messages ? { messages: ArchivedJsonValueSchema.array().parse(messages) } : undefined;
  const container = document.createElement('div');
  document.body.append(container);
  mounted = createRoot(container);
  flushSync(() =>
    mounted?.render(createElement(ClosedSessionTranscriptView, { sessionId: 'closed' }))
  );
  return container;
}
const user = (text: string, extra = {}) => ({
  id: 'duplicate',
  source: 'user',
  timestamp: '',
  order: 0,
  text,
  ...extra,
});
const tool = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: '/example.txt' },
});
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` });
const agent = (id: string, content: unknown[]) => ({
  id,
  source: 'agent',
  timestamp: '',
  order: 0,
  message: { type: 'assistant', message: { role: 'assistant', content } },
});

describe('compatible archive view with real projection and rich renderer', () => {
  it('retains loading, missing and empty states', () => {
    query.isLoading = true;
    expect(render().textContent).toContain('Loading transcript...');
    query.isLoading = false;
    flushSync(() =>
      mounted?.render(createElement(ClosedSessionTranscriptView, { sessionId: 'closed' }))
    );
    expect(document.body.textContent).toContain('Transcript not found');
    query.data = { messages: [] };
    flushSync(() =>
      mounted?.render(createElement(ClosedSessionTranscriptView, { sessionId: 'closed' }))
    );
    expect(document.body.textContent).toContain('No messages in this session');
  });

  it('keeps rich/opaque/orphan order and escapes full hostile raw JSON as text', () => {
    const hostile = {
      role: 'future',
      nested: { text: '<script>alert(1)</script><img src=x onerror=alert(2)>', keep: [null, 7] },
    };
    const orphan = agent('orphan', [result('A')]);
    const container = render([
      user('first rich'),
      agent('call', [tool('A')]),
      hostile,
      orphan,
      user('last rich'),
    ]);
    const pre = [...container.querySelectorAll('section[aria-label="Archived message JSON"] pre')];
    expect(pre.map((node) => node.textContent)).toEqual([
      JSON.stringify(hostile, null, 2),
      JSON.stringify(orphan, null, 2),
    ]);
    expect(container.querySelector('script,img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;script&gt;');
    expect(container.textContent?.indexOf('first rich')).toBeLessThan(
      container.textContent?.indexOf('future') ?? 0
    );
    expect(container.textContent?.indexOf('future')).toBeLessThan(
      container.textContent?.indexOf('orphan') ?? 0
    );
    expect(container.textContent?.indexOf('orphan')).toBeLessThan(
      container.textContent?.indexOf('last rich') ?? 0
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it.each(['adjacent', 'late'])(
    'keeps an entire %s multi-result row once after rich content',
    (mode) => {
      const mixed = agent('mixed', [result('A'), result('B')]);
      const container = render([
        agent('call', [tool('A')]),
        ...(mode === 'late' ? [user('between rich')] : []),
        mixed,
        user('after rich'),
      ]);
      const pre = container.querySelectorAll('section[aria-label="Archived message JSON"] pre');
      expect(pre.length).toBe(1);
      expect(pre[0]?.textContent).toBe(JSON.stringify(mixed, null, 2));
      expect(container.textContent?.indexOf('Read')).toBeLessThan(
        container.textContent?.indexOf('mixed') ?? 0
      );
      expect(container.textContent?.indexOf('mixed')).toBeLessThan(
        container.textContent?.indexOf('after rich') ?? 0
      );
    }
  );

  it('renders a same-index current rich item before its complete orphan fallback', () => {
    const mixed = agent('mixed', [tool('B'), result('unknown')]);
    const container = render([mixed]);
    expect(container.textContent?.indexOf('Read')).toBeLessThan(
      container.textContent?.indexOf('mixed') ?? 0
    );
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(mixed, null, 2));
  });

  it('keeps current undeclared extras rich-only and invalid-known rows opaque', () => {
    const invalid = { ...user('invalid'), order: 'not numeric', extra: { keep: true } };
    const container = render([
      user('current rich', { extension: 'not shown' }),
      invalid,
      null,
      3,
      ['legacy'],
    ]);
    expect(container.textContent).toContain('current rich');
    expect(container.textContent).not.toContain('not shown');
    expect([...container.querySelectorAll('pre')].map((node) => node.textContent)).toEqual(
      [invalid, null, 3, ['legacy']].map((value) => JSON.stringify(value, null, 2))
    );
  });
});
