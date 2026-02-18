// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolResultContentRenderer } from './tool-result-renderer';

afterEach(() => {
  document.body.innerHTML = '';
});

function renderToolResult(props: Parameters<typeof ToolResultContentRenderer>[0]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ToolResultContentRenderer, props));
  });

  return container;
}

describe('ToolResultContentRenderer', () => {
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
