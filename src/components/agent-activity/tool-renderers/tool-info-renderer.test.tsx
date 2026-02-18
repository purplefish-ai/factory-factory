// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PairedToolCall, ToolSequence } from '@/lib/chat-protocol';
import { ToolSequenceGroup } from './tool-info-renderer';

function createCall(id: string, name: string): PairedToolCall {
  return {
    id,
    name,
    input: { file_path: `${id}.ts` },
    status: 'success',
    result: {
      content: 'ok',
      isError: false,
    },
  };
}

function countTriggerButtons(container: HTMLElement): number {
  return container.querySelectorAll('button').length;
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ToolSequenceGroup', () => {
  it('auto-opens when a sequence grows from one call to multiple calls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const singleSequence: ToolSequence = {
      type: 'tool_sequence',
      id: 'seq-1',
      pairedCalls: [createCall('read-1', 'Read')],
    };

    flushSync(() => {
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: singleSequence,
          defaultOpen: false,
          summaryOrder: 'latest-first',
        })
      );
    });

    expect(countTriggerButtons(container)).toBe(1);

    const multiSequence: ToolSequence = {
      type: 'tool_sequence',
      id: 'seq-1',
      pairedCalls: [createCall('read-1', 'Read'), createCall('edit-1', 'Edit')],
    };

    flushSync(() => {
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: multiSequence,
          defaultOpen: true,
          summaryOrder: 'latest-first',
        })
      );
    });

    await flushEffects();

    // Group header + one trigger for each paired tool row.
    expect(countTriggerButtons(container)).toBe(3);

    root.unmount();
  });

  it('toggles when open is provided without onOpenChange', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const sequence: ToolSequence = {
      type: 'tool_sequence',
      id: 'seq-1',
      pairedCalls: [createCall('read-1', 'Read'), createCall('edit-1', 'Edit')],
    };

    flushSync(() => {
      root.render(
        createElement(ToolSequenceGroup, {
          sequence,
          open: false,
          summaryOrder: 'latest-first',
        })
      );
    });

    expect(countTriggerButtons(container)).toBe(1);

    const trigger = container.querySelector('button');
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushEffects();

    // Group header + one trigger for each paired tool row.
    expect(countTriggerButtons(container)).toBe(3);

    root.unmount();
  });
});
