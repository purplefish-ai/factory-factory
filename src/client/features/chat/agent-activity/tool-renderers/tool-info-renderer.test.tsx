// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('stays collapsed when a sequence grows from one call to multiple calls', async () => {
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
          defaultOpen: false,
          summaryOrder: 'latest-first',
        })
      );
    });

    await flushEffects();

    expect(countTriggerButtons(container)).toBe(1);

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

  it('preserves controlled expansion when a sequence grows', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onOpenChange = vi.fn();

    const singleSequence: ToolSequence = {
      type: 'tool_sequence',
      id: 'seq-1',
      pairedCalls: [createCall('read-1', 'Read')],
    };

    flushSync(() => {
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: singleSequence,
          open: false,
          onOpenChange,
          defaultOpen: false,
          summaryOrder: 'latest-first',
        })
      );
    });

    const multiSequence: ToolSequence = {
      type: 'tool_sequence',
      id: 'seq-1',
      pairedCalls: [createCall('read-1', 'Read'), createCall('edit-1', 'Edit')],
    };

    flushSync(() => {
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: multiSequence,
          open: false,
          onOpenChange,
          defaultOpen: false,
          summaryOrder: 'latest-first',
        })
      );
    });

    await flushEffects();

    expect(onOpenChange).not.toHaveBeenCalled();

    root.unmount();
  });
});

describe('quiet activity summaries', () => {
  it('summarizes a single command and reveals its details on demand', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const call = {
      ...createCall('bash', 'Bash'),
      input: { command: 'pnpm test', description: 'Run the full unit suite' },
      result: { content: 'All tests passed', isError: false },
    };
    flushSync(() =>
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: { type: 'tool_sequence', id: 'seq', pairedCalls: [call] },
        })
      )
    );
    expect(container.textContent).toBe('Ran commands');
    expect(container.textContent).not.toContain('Success');
    expect(container.textContent).not.toContain('All tests passed');
    expect(container.textContent).not.toContain('Run the full unit suite');
    flushSync(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Ran pnpm test');
    expect(container.textContent).not.toContain('All tests passed');
    flushSync(() => container.querySelectorAll('button')[1]?.click());
    expect(container.textContent).toContain('All tests passed');
    expect(container.textContent).toContain('Run the full unit suite');
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    root.unmount();
  });

  it('keeps failures inside expanded activity', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const command = {
      ...createCall('bash', 'Bash'),
      input: { command: 'pnpm test' },
      status: 'error' as const,
      result: { content: 'Test failed', isError: true },
    };
    flushSync(() =>
      root.render(
        createElement(ToolSequenceGroup, {
          sequence: {
            type: 'tool_sequence',
            id: 'seq',
            pairedCalls: [createCall('edit', 'Edit'), command],
          },
        })
      )
    );
    expect(container.textContent).toContain('Edited a file, ran commands');
    expect(container.textContent).not.toMatch(/failed|error/i);
    expect(container.querySelector('button')?.className).not.toContain('text-destructive');
    flushSync(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Failed pnpm test');
    expect(container.textContent).not.toContain('Success');
    root.unmount();
  });
});

describe('bounded command previews in expanded activity', () => {
  const command = `printf ${'x'.repeat(200)}`;
  it.each([
    { name: 'Bash', input: { command } },
    { name: 'exec_command', input: { cmd: command } },
    { name: 'Run', input: { command: ['zsh', '-lc', command] } },
  ])('bounds the $name summary and preserves full input in details', ({ name, input }) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const call = { ...createCall('command', name), input };
    try {
      flushSync(() =>
        root.render(
          createElement(ToolSequenceGroup, {
            sequence: { type: 'tool_sequence', id: 'bounded', pairedCalls: [call] },
          })
        )
      );
      const trigger = container.querySelector('button');
      expect(trigger?.textContent?.length).toBeLessThanOrEqual(84);
      expect(trigger?.textContent).toBe('Ran commands');
      flushSync(() => trigger?.click());
      const commandTrigger = container.querySelectorAll('button')[1];
      expect(commandTrigger?.textContent?.length).toBeLessThanOrEqual(84);
      expect(commandTrigger?.textContent).toMatch(/…$/);
      flushSync(() => commandTrigger?.click());
      expect(container.textContent).toContain(command);
    } finally {
      root.unmount();
    }
  });
});

describe('single activity summaries', () => {
  it.each([
    { name: 'Read', status: 'success' as const, label: 'Read files' },
    { name: 'Bash', status: 'error' as const, label: 'Ran commands' },
    { name: 'exec_command', status: 'pending' as const, label: 'Running commands' },
  ])('summarizes $name with status $status', ({ name, status, label }) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const call = { ...createCall('single', name), status };
    try {
      flushSync(() =>
        root.render(
          createElement(ToolSequenceGroup, {
            sequence: { type: 'tool_sequence', id: 'single', pairedCalls: [call] },
          })
        )
      );
      const trigger = container.querySelector('button');
      expect(trigger?.textContent).toBe(label + (status === 'pending' ? 'Running' : ''));
      expect(trigger?.className).not.toContain('text-destructive');
      expect(container.textContent).not.toContain('single.ts');
      flushSync(() => trigger?.click());
      expect(container.textContent).toContain(name === 'Read' ? 'single.ts' : 'command');
    } finally {
      root.unmount();
    }
  });
});
