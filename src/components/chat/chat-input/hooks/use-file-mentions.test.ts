// @vitest-environment jsdom

import { createElement, createRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFileMentions } from './use-file-mentions';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      listAllFiles: {
        useQuery: () => ({ data: { files: [] }, isLoading: false }),
      },
    },
  },
}));

type FileMentionsResult = ReturnType<typeof useFileMentions>;

interface HarnessProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onResult: (result: FileMentionsResult) => void;
}

function Harness({ inputRef, onChange, onResult }: HarnessProps) {
  const result = useFileMentions({
    workspaceId: 'workspace-1',
    inputRef,
    onChange,
  });
  onResult(result);
  return createElement('textarea', { ref: inputRef });
}

interface RenderedHook {
  getResult: () => FileMentionsResult;
  onChange: ReturnType<typeof vi.fn<(value: string) => void>>;
  textarea: HTMLTextAreaElement;
}

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderHook(): RenderedHook {
  const container = document.createElement('div');
  const root = createRoot(container);
  const inputRef = createRef<HTMLTextAreaElement>();
  const onChange = vi.fn<(value: string) => void>();
  let result: FileMentionsResult | undefined;

  document.body.appendChild(container);
  mountedRoots.push({ container, root });
  flushSync(() => {
    root.render(
      createElement(Harness, {
        inputRef,
        onChange,
        onResult: (nextResult) => {
          result = nextResult;
        },
      })
    );
  });

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
    onChange,
    textarea,
  };
}

function openMentionMenu(rendered: RenderedHook, value: string) {
  rendered.textarea.value = value;
  rendered.textarea.setSelectionRange(value.length, value.length);
  flushSync(() => {
    rendered.getResult().detectFileMention(value);
  });
  expect(rendered.getResult().fileMentionMenuOpen).toBe(true);
}

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    flushSync(() => root.unmount());
    container.remove();
  }
});

describe('useFileMentions selection', () => {
  it('does not insert a file after the cursor moves before the active mention', () => {
    const rendered = renderHook();
    const value = 'Hello @src';
    openMentionMenu(rendered, value);

    rendered.textarea.setSelectionRange(3, 3);
    flushSync(() => {
      rendered.getResult().handleFileMentionSelect('src/foo.ts');
    });

    expect(rendered.textarea.value).toBe(value);
    expect(rendered.onChange).not.toHaveBeenCalled();
    expect(rendered.getResult().fileMentionMenuOpen).toBe(false);
    expect(rendered.getResult().fileMentionFilter).toBe('');
  });

  it('does not insert a file after the cursor moves inside the active mention', () => {
    const rendered = renderHook();
    const value = '@src';
    openMentionMenu(rendered, value);

    rendered.textarea.setSelectionRange(1, 1);
    flushSync(() => {
      rendered.getResult().handleFileMentionSelect('src/bar.ts');
    });

    expect(rendered.textarea.value).toBe(value);
    expect(rendered.onChange).not.toHaveBeenCalled();
    expect(rendered.getResult().fileMentionMenuOpen).toBe(false);
    expect(rendered.getResult().fileMentionFilter).toBe('');
  });

  it('inserts a file when the cursor remains at the end of the active mention', () => {
    const rendered = renderHook();
    openMentionMenu(rendered, 'Hello @src');

    flushSync(() => {
      rendered.getResult().handleFileMentionSelect('src/foo.ts');
    });

    const expectedValue = 'Hello @src/foo.ts ';
    expect(rendered.textarea.value).toBe(expectedValue);
    expect(rendered.textarea.selectionStart).toBe(expectedValue.length);
    expect(rendered.textarea.selectionEnd).toBe(expectedValue.length);
    expect(rendered.onChange).toHaveBeenCalledOnce();
    expect(rendered.onChange).toHaveBeenCalledWith(expectedValue);
  });

  it('uses the mention at the live cursor position instead of the stored position', () => {
    const rendered = renderHook();
    openMentionMenu(rendered, '@one and @two');

    rendered.textarea.setSelectionRange(4, 4);
    flushSync(() => {
      rendered.getResult().handleFileMentionSelect('src/foo.ts');
    });

    expect(rendered.textarea.value).toBe('@src/foo.ts  and @two');
    expect(rendered.onChange).toHaveBeenCalledWith('@src/foo.ts  and @two');
  });
});
