// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GroupedMessageItemRendererProps } from './agent-activity/agent-activity';
import { createToolSequenceExpansionKey } from './agent-activity/tool-renderers/tool-expansion-state';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';

const render = vi.hoisted(() => vi.fn());
vi.mock('./agent-activity', () => ({
  GroupedMessageItemRenderer: (props: GroupedMessageItemRendererProps) => {
    render(props);
    return (
      <button
        type="button"
        data-message={props.item.id}
        onClick={() =>
          props.setToolExpansionState?.(createToolSequenceExpansionKey(props.item.id), false)
        }
      >
        Toggle tool
      </button>
    );
  },
}));

it('rerenders a memoized tool row when persisted expansion changes without remounting its message', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const item = {
    type: 'tool_sequence' as const,
    id: 'expansion-tool',
    pairedCalls: [1, 2].map((i) => ({
      id: `call-${i}`,
      name: 'Read',
      input: {},
      status: 'success' as const,
    })),
  };
  try {
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          workspaceId="expansion-workspace"
          messages={[item]}
          running={false}
          startingSession={false}
          loadingSession={false}
        />
      )
    );
    const node = host.querySelector<HTMLButtonElement>('[data-message="expansion-tool"]');
    const before = render.mock.lastCall?.[0].toolExpansionToken;
    flushSync(() => node?.click());
    expect(render.mock.lastCall?.[0].toolExpansionToken).not.toBe(before);
    expect(host.querySelector('[data-message="expansion-tool"]')).toBe(node);
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          workspaceId="expansion-workspace"
          messages={[
            item,
            {
              id: 'next',
              source: 'user',
              text: 'Next',
              order: 1,
              timestamp: '2026-10-30T00:00:00Z',
            },
          ]}
          running={false}
          startingSession={false}
          loadingSession={false}
        />
      )
    );
    expect(host.querySelector('[data-message="expansion-tool"]')).toBe(node);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    localStorage.removeItem('workspace-tool-call-expansion-expansion-workspace');
  }
});
