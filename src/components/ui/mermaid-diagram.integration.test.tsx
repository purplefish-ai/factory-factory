// @vitest-environment jsdom

import mermaid from 'mermaid';
import { expect, it } from 'vitest';
import './mermaid-diagram';

it.each([
  ['flowchart', 'graph LR\nWorkspace --> Session'],
  ['class', 'classDiagram\nWorkspace --> Session'],
  ['state', 'stateDiagram-v2\nReady --> Running'],
])('preserves the existing %s appearance with the real Mermaid engine', async (_type, chart) => {
  await mermaid.parse(chart);

  // Mermaid 12 supplies diagram-specific defaults. Check the effective engine
  // configuration after parsing, rather than mocking initialize().
  expect(mermaid.mermaidAPI.getConfig()).toMatchObject({
    layout: 'dagre',
    theme: 'default',
    look: 'classic',
  });
});

it('prevents diagram frontmatter from relaxing strict security', async () => {
  await mermaid.parse('---\nconfig:\n  securityLevel: loose\n---\ngraph LR\nA --> B');

  expect(mermaid.mermaidAPI.getConfig().securityLevel).toBe('strict');
});
