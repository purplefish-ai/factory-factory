// @vitest-environment jsdom

import mermaid from 'mermaid';
import { expect, it } from 'vitest';
import { beforeEach, vi } from 'vitest';
import { mermaidThemeConfig } from '@/client/lib/mermaid-renderer';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '#123456',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: [18, 52, 86, 255] }),
  } as unknown as CanvasRenderingContext2D);
  mermaid.initialize(mermaidThemeConfig(document.body));
});

it.each([
  ['flowchart', 'graph LR\nWorkspace --> Session'],
  ['class', 'classDiagram\nWorkspace --> Session'],
  ['state', 'stateDiagram-v2\nReady --> Running'],
])(
  'uses the application theme for %s diagrams with the real Mermaid engine',
  async (_type, chart) => {
    await mermaid.parse(chart);

    // Mermaid 12 supplies diagram-specific defaults. Check the effective engine
    // configuration after parsing, rather than mocking initialize().
    expect(mermaid.mermaidAPI.getConfig()).toMatchObject({
      layout: 'dagre',
      theme: 'base',
      look: 'classic',
    });
  }
);

it('prevents diagram frontmatter from relaxing strict security', async () => {
  await mermaid.parse(
    '---\nconfig:\n  securityLevel: loose\n  theme: default\n  themeVariables:\n    primaryColor: "#ff0000"\n---\ngraph LR\nA --> B'
  );

  expect(mermaid.mermaidAPI.getConfig()).toMatchObject({
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: { primaryColor: '#123456' },
  });
});
