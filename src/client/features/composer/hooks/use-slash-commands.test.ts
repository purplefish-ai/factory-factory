// @vitest-environment jsdom

import {
  act,
  type ChangeEvent,
  createElement,
  createRef,
  type RefObject,
  useLayoutEffect,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandInfo } from '@/lib/chat-protocol';
import { useSlashCommands } from './use-slash-commands';

type SlashCommandsResult = ReturnType<typeof useSlashCommands>;

interface HarnessProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  slashCommands: CommandInfo[];
  enabled: boolean;
  onResult: (result: SlashCommandsResult) => void;
  onCommit: (result: SlashCommandsResult) => void;
}

function Harness({ inputRef, slashCommands, enabled, onResult, onCommit }: HarnessProps) {
  const result = useSlashCommands({
    inputRef,
    slashCommands,
    enabled,
  });
  onResult(result);
  // Layout effects see each commit before passive effects could correct it.
  useLayoutEffect(() => onCommit(result));
  return createElement('textarea', { ref: inputRef });
}

interface RenderedHook {
  getResult: () => SlashCommandsResult;
  rerender: (slashCommands: CommandInfo[], enabled?: boolean) => void;
  commits: SlashCommandsResult[];
  textarea: HTMLTextAreaElement;
}

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

function renderHook(initialSlashCommands: CommandInfo[]): RenderedHook {
  const container = document.createElement('div');
  const root = createRoot(container);
  const inputRef = createRef<HTMLTextAreaElement>();
  let result: SlashCommandsResult | undefined;
  const commits: SlashCommandsResult[] = [];

  const render = (slashCommands: CommandInfo[], enabled = true) => {
    root.render(
      createElement(Harness, {
        inputRef,
        slashCommands,
        enabled,
        onResult: (nextResult) => {
          result = nextResult;
        },
        onCommit: (committed) => {
          commits.push(committed);
        },
      })
    );
  };

  document.body.appendChild(container);
  mountedRoots.push({ container, root });
  void act(() => render(initialSlashCommands));

  const textarea = inputRef.current;
  if (!textarea) {
    throw new Error('Expected the hook harness to render a textarea');
  }

  return {
    getResult: () => {
      if (!result) {
        throw new Error('Expected the hook harness to expose a result');
      }
      return result;
    },
    rerender: (slashCommands, enabled) => {
      void act(() => render(slashCommands, enabled));
    },
    commits,
    textarea,
  };
}

function changeInput(rendered: RenderedHook, value: string) {
  rendered.textarea.value = value;
  void act(() => {
    rendered
      .getResult()
      .handleInputChange({ target: rendered.textarea } as ChangeEvent<HTMLTextAreaElement>);
  });
}

const helpCommand: CommandInfo = {
  name: 'help',
  description: 'Show available commands',
};

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    void act(() => root.unmount());
    container.remove();
  }
});

describe('useSlashCommands async loading', () => {
  it('keeps the palette closed when commands arrive after the user dismisses it', () => {
    const rendered = renderHook([]);
    changeInput(rendered, '/');

    expect(rendered.getResult().slashMenuOpen).toBe(true);
    void act(() => rendered.getResult().handleSlashMenuClose());
    expect(rendered.getResult().slashMenuOpen).toBe(false);

    rendered.rerender([helpCommand]);

    expect(rendered.getResult().slashMenuOpen).toBe(false);
  });

  it('treats close-and-passthrough keyboard handling as a dismissal', () => {
    const rendered = renderHook([helpCommand]);
    changeInput(rendered, '/missing');
    rendered.getResult().paletteRef.current = {
      handleKeyDown: () => 'close-and-passthrough',
    };

    void act(() => {
      expect(rendered.getResult().delegateToSlashMenu('Enter')).toBe('close-and-passthrough');
    });
    expect(rendered.getResult().slashMenuOpen).toBe(false);

    rendered.rerender([helpCommand, { name: 'status', description: 'Show current status' }]);

    expect(rendered.getResult().slashMenuOpen).toBe(false);
  });

  it('opens the palette again when the user resumes typing after dismissal', () => {
    const rendered = renderHook([]);
    changeInput(rendered, '/');
    void act(() => rendered.getResult().handleSlashMenuClose());

    changeInput(rendered, '/h');

    expect(rendered.getResult().slashMenuOpen).toBe(true);
    expect(rendered.getResult().slashFilter).toBe('h');
  });

  it('opens the palette when commands arrive without an explicit dismissal', () => {
    const rendered = renderHook([]);
    rendered.textarea.value = '/he';

    rendered.rerender([helpCommand]);

    expect(rendered.getResult().slashMenuOpen).toBe(true);
    expect(rendered.getResult().slashFilter).toBe('he');
  });
});

describe('useSlashCommands when disabled', () => {
  it('closes the palette and clears its filter in the first commit after disabling', () => {
    const rendered = renderHook([helpCommand]);
    changeInput(rendered, '/he');
    expect(rendered.getResult().slashMenuOpen).toBe(true);

    const before = rendered.commits.length;
    rendered.rerender([helpCommand], false);

    expect(
      rendered.commits.slice(before).map(({ slashMenuOpen, slashFilter }) => ({
        slashMenuOpen,
        slashFilter,
      }))
    ).toEqual([{ slashMenuOpen: false, slashFilter: '' }]);
  });
});
