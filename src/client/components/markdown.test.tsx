// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('uses Streamdown for live application Markdown and settles to exact static content', async () => {
  await act(() => root.render(<MarkdownRenderer content="**Growing bold" streaming />));
  expect(container.textContent).toBe('Growing bold');
  expect(container.querySelector('strong')?.textContent).toBe('Growing bold');
  expect(container.querySelector('[data-sd-animate]')).not.toBeNull();

  await act(() => root.render(<MarkdownRenderer content="**Growing bold" />));
  expect(container.textContent).toBe('**Growing bold');
  expect(container.querySelector('[data-sd-animate]')).toBeNull();
});

it('shows historical messages immediately without reveal spans', async () => {
  await act(() =>
    root.render(<MarkdownRenderer content={'## Saved reply\n\n**Finished** text.'} />)
  );
  expect(container.querySelector('h2')?.textContent).toBe('Saved reply');
  expect(container.querySelector('strong')?.textContent).toBe('Finished');
  expect(container.querySelector('[data-sd-animate]')).toBeNull();
});
