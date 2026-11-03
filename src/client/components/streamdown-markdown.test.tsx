// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { renderStreamdownContent } from './streamdown-markdown';

let root: Root;
let container: HTMLDivElement;
let reducedMotion: boolean;
let notifyMotionChange: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reducedMotion = false;
  notifyMotionChange = undefined;
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reducedMotion;
    },
    addEventListener: (_event: string, listener: () => void) => {
      notifyMotionChange = listener;
    },
    removeEventListener: () => {
      notifyMotionChange = undefined;
    },
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

const render = (props: ComponentProps<typeof MarkdownRenderer>) =>
  act(() => root.render(<MarkdownRenderer {...props} renderContent={renderStreamdownContent} />));

describe('Streamdown Markdown adapter', () => {
  it('retains semantic strong text instead of replacing it with a styled span', async () => {
    await render({ content: '## Heading\n\n**Important** text', streaming: true });
    expect(container.querySelector('h2')?.textContent).toBe('Heading');
    expect(container.querySelector('strong')?.textContent).toBe('Important');
  });

  it('formats incomplete prose and settles to exact Markdown without animated spans', async () => {
    await render({ content: '**Growing bold', streaming: true });
    expect(container.textContent).toBe('Growing bold');
    expect(container.querySelector('[data-sd-animate]')).not.toBeNull();
    await render({ content: '**Growing bold', streaming: false });
    expect(container.textContent).toBe('**Growing bold');
    expect(container.querySelector('[data-sd-animate]')).toBeNull();
  });

  it('does not queue word animations when a large burst arrives', async () => {
    await render({ content: 'word '.repeat(1000), streaming: true });
    const words = [...container.querySelectorAll<HTMLElement>('[data-sd-animate]')];
    expect(words).toHaveLength(1000);
    expect(
      words.every((word) => !Number.parseFloat(word.style.getPropertyValue('--sd-delay')))
    ).toBe(true);
  });

  it('respects reduced motion and responds to preference changes', async () => {
    reducedMotion = true;
    await render({ content: 'Growing prose', streaming: true });
    expect(container.textContent).toBe('Growing prose');
    expect(container.querySelector('[data-sd-animate]')).toBeNull();
    await act(() => {
      reducedMotion = false;
      notifyMotionChange?.();
    });
    expect(container.querySelector('[data-sd-animate]')).not.toBeNull();
    await act(() => {
      reducedMotion = true;
      notifyMotionChange?.();
    });
    expect(container.querySelector('[data-sd-animate]')).toBeNull();
  });

  it('uses the latest workspace link handler even when the text is unchanged', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const resolveWorkspaceFileLink = () => 'src/file.ts';
    const content = '[File](C:/repo/src/file.ts:12)';
    await render({ content, resolveWorkspaceFileLink, onWorkspaceFileLink: first });
    await render({ content, resolveWorkspaceFileLink, onWorkspaceFileLink: second });
    await act(() => container.querySelector('a')?.click());
    expect(second).toHaveBeenCalledWith('src/file.ts');
    expect(first).not.toHaveBeenCalled();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('C:/repo/src/file.ts:12');
  });

  it('updates the file-tab callback without remounting the streaming reply', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const resolveWorkspaceFileLink = () => 'src/file.ts';
    const content = '**Live reply** with a [file](C:/repo/src/file.ts).';
    await render({
      content,
      streaming: true,
      resolveWorkspaceFileLink,
      onWorkspaceFileLink: first,
    });
    const paragraph = container.querySelector('p');
    const word = container.querySelector('[data-sd-animate]');
    expect(paragraph).not.toBeNull();
    expect(word).not.toBeNull();

    await render({
      content,
      streaming: true,
      resolveWorkspaceFileLink,
      onWorkspaceFileLink: second,
    });
    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('[data-sd-animate]')).toBe(word);
    await act(() => container.querySelector('a')?.click());
    expect(second).toHaveBeenCalledWith('src/file.ts');
    expect(first).not.toHaveBeenCalled();
  });

  it('preserves local image sources, literal HTML and the existing unsafe-link policy', async () => {
    const sources: (string | undefined)[] = [];
    await render({
      content: '![Preview](./image.png)\n\n<em>literal</em>\n\n[Unsafe](javascript:alert%281%29)',
      renderImage: ({ src }) => {
        sources.push(src);
        return <span>Preview</span>;
      },
    });
    expect(sources).toContain('./image.png');
    expect(container.textContent).toContain('<em>literal</em>');
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('');
  });

  it('retains reference links and fenced code while streaming', async () => {
    await render({
      content: 'See [docs][ref].\n\n```ts\nconst x = 1;\n```\n\n[ref]: https://example.com',
      streaming: true,
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
    expect(container.querySelector('pre [data-sd-animate]')).toBeNull();
  });
});
