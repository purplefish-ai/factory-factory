// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let capturedSeparatorClassName: string | undefined;

vi.mock('react-resizable-panels', () => ({
  Group: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  Panel: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  Separator: (props: { className?: string; children?: ReactNode }) => {
    capturedSeparatorClassName = props.className;
    return createElement('div', null, props.children);
  },
}));

vi.mock('lucide-react', () => ({
  GripVertical: () => createElement('svg'),
}));

import { ResizableHandle } from './resizable';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

function renderInDom(render: (root: Root) => void): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  render(root);
  return () => {
    root.unmount();
    container.remove();
  };
}

beforeEach(() => {
  capturedSeparatorClassName = undefined;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ResizableHandle hit target classes', () => {
  it('includes pseudo-element content class for horizontal group handles', () => {
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(createElement(ResizableHandle));
      });
    });

    expect(capturedSeparatorClassName).toContain("after:content-['']");
    expect(capturedSeparatorClassName).toContain('cursor-col-resize');
    cleanup();
  });

  it('includes row-resize cursor for vertical group handles', () => {
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(createElement(ResizableHandle, { direction: 'vertical' }));
      });
    });

    expect(capturedSeparatorClassName).toContain("after:content-['']");
    expect(capturedSeparatorClassName).toContain('cursor-row-resize');
    cleanup();
  });
});
