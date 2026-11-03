// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolResultContentRenderer } from './tool-result-renderer';

const roots: Root[] = [];
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
afterEach(() => {
  flushSync(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
});

function renderToolResult(props: Parameters<typeof ToolResultContentRenderer>[0]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  flushSync(() => {
    root.render(createElement(ToolResultContentRenderer, props));
  });

  return container;
}

describe('ToolResultContentRenderer', () => {
  it('retains the data URI of an unsupported image in a copyable fallback', () => {
    const container = renderToolResult({
      isError: false,
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' },
        },
      ],
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(container.querySelector('textarea')?.readOnly).toBe(true);
  });
  it('renders image results alongside text with a full-size control', () => {
    const container = renderToolResult({
      isError: false,
      content: [
        { type: 'text', text: 'Generated mockup' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png },
        },
      ],
    });
    expect(container.textContent).toContain('Generated mockup');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `data:image/png;base64,${png}`
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Open tool result image at full size'
    );
    flushSync(() => container.querySelector('button')!.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      `data:image/png;base64,${png}`
    );
  });

  const fileChangeJson = JSON.stringify({
    type: 'fileChange',
    changes: [{ path: '/repo/src/app.ts', kind: { type: 'update', move_path: null } }],
  });
  const fileChangeWithEnvelopeJson = JSON.stringify({
    type: 'fileChange',
    id: 'call_123',
    status: 'completed',
    changes: [{ path: '/repo/src/app.ts', kind: { type: 'update', move_path: null } }],
  });

  it('preserves specialized text rendering alongside image results', () => {
    const container = renderToolResult({
      isError: false,
      toolName: 'fileChange',
      content: [
        { type: 'text', text: fileChangeJson },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png },
        },
      ],
    });
    expect(container.textContent).toContain('1 file change');
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('keeps mixed image and text blocks in source order', () => {
    const container = renderToolResult({
      isError: false,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: 'Caption after image' },
      ],
    });
    const blocks = container.querySelectorAll('img, pre');
    expect(Array.from(blocks).map((block) => block.tagName)).toEqual(['IMG', 'PRE']);
  });

  it('renders fileChange payloads with the specialized renderer for non-error results', () => {
    const container = renderToolResult({
      content: fileChangeJson,
      isError: false,
      toolName: 'fileChange',
    });

    expect(container.textContent).toContain('1 file change');
    expect(container.textContent).toContain('Modified');
  });

  it('renders standalone fileChange payloads only with a codex-like envelope', () => {
    const container = renderToolResult({
      content: fileChangeWithEnvelopeJson,
      isError: false,
    });

    expect(container.textContent).toContain('1 file change');
    expect(container.textContent).toContain('Modified');
  });

  it('falls back to plain text for standalone fileChange-like payloads without envelope metadata', () => {
    const container = renderToolResult({
      content: fileChangeJson,
      isError: false,
    });

    expect(container.textContent).toContain(fileChangeJson);
    expect(container.textContent).not.toContain('1 file change');
  });

  it('falls back to error text rendering when tool result is an error', () => {
    const container = renderToolResult({
      content: fileChangeJson,
      isError: true,
      toolName: 'fileChange',
    });

    expect(container.textContent).toContain(fileChangeJson);
    expect(container.textContent).not.toContain('1 file change');
  });
});
