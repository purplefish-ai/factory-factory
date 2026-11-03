// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ToolSequenceGroup } from './tool-info-renderer';

it.each([
  ['mcp.codex_apps.github.fetch_pr_comments', 'Fetch PR comments · GitHub', 'GitHub'],
  ['mcp__my_server__fetchBuildStatus', 'Fetch build status · My server', 'My server'],
  ['List files in task workspace/src', 'List files', 'Listed files'],
])(
  'keeps %s readable and preserves its identifier and input on expansion',
  (name, label, summary) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(
          createElement(ToolSequenceGroup, {
            sequence: {
              type: 'tool_sequence',
              id: 'mcp',
              pairedCalls: [
                {
                  id: 'call',
                  name,
                  input: { path: '/project/tasks', pr: 123 },
                  status: 'success',
                },
              ],
            },
          })
        )
      );
      expect(container.textContent).toBe(summary);
      flushSync(() => container.querySelector('button')?.click());
      const row = container.querySelectorAll('button')[1];
      expect(row?.textContent).toBe(label);
      expect(row?.querySelector('[title]')?.getAttribute('title')).toBe(name);
      expect(container.textContent).not.toContain('/project/tasks');
      flushSync(() => row?.click());
      expect(container.textContent).toContain(name);
      expect(container.textContent).toContain('/project/tasks');
      expect(container.textContent).toContain('123');
    } finally {
      root.unmount();
    }
  }
);
