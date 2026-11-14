import type { Meta, StoryObj } from '@storybook/react';
import mermaid from 'mermaid';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { contrastRatio, type Rgb } from '@/client/lib/color-contrast';
import { mermaidThemeConfig } from '@/client/lib/mermaid-renderer';
import { Button } from '@/components/ui/button';
import MermaidDiagram from './mermaid-diagram';

const charts = [
  'graph LR\nWorkspace --> Session\nSession --> Result',
  'classDiagram\nWorkspace "1" --> "*" Session',
  'stateDiagram-v2\n[*] --> Ready\nReady --> Running\nRunning --> Complete',
  'pie title Workspaces\n"Active" : 3\n"Ready" : 2',
  'gantt\ntitle Delivery\ndateFormat YYYY-MM-DD\nsection Build\nImplement :active, a1, 2026-11-01, 3d\nVerify :after a1, 2d',
  'mindmap\n  root((Workspace))\n    Session\n    Changes',
  'sequenceDiagram\nUser->>Agent: Build feature\nNote over Agent: Working\nAgent-->>User: Ready',
];

// Mermaid fetches each diagram type's code the first time it meets one, so the
// file's first story paid for all seven inside its 5 s wait. In a full story
// run the shared Vite server serves that code late, and Factory Light, the
// first story, failed every loaded run. Fetch it once, before any story renders.
let diagramTypesLoaded: Promise<void> | undefined;
async function loadDiagramTypes() {
  for (const chart of charts) {
    await mermaid.parse(chart);
  }
}

function Gallery() {
  return (
    <div className="max-w-3xl bg-background text-foreground p-6">
      {charts.map((chart) => (
        <MermaidDiagram key={chart} chart={chart} />
      ))}
    </div>
  );
}

const meta = {
  title: 'Chat/Transcript/MermaidDiagram',
  component: Gallery,
  parameters: { layout: 'padded' },
  loaders: [
    async () => {
      diagramTypesLoaded ??= loadDiagramTypes();
      await diagramTypesLoaded;
      return {};
    },
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('svg')).toHaveLength(charts.length));
    const config = mermaidThemeConfig(canvasElement);
    await expect(canvasElement.querySelector('svg')?.textContent).toContain(
      config.themeVariables.primaryColor
    );
    await expect(canvasElement.textContent).not.toContain('Error rendering diagram');
    const context = document.createElement('canvas').getContext('2d');
    if (!context) {
      throw new Error('Canvas unavailable');
    }
    const rgb = (color: string): Rgb => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r / 255, g / 255, b / 255];
    };
    const threshold = document.documentElement.dataset.colorScheme === 'high-contrast' ? 7 : 4.5;
    const mindmapRoot = canvasElement.querySelector('.mindmap-node.section-root circle');
    if (!mindmapRoot) {
      throw new Error('Missing mindmap root');
    }
    await expect(rgb(getComputedStyle(mindmapRoot).stroke)).toEqual(
      rgb(config.themeVariables.primaryBorderColor)
    );
    for (const [shapeSelector, textSelector, property, fillToken, textToken] of [
      ['.node rect', '.node .nodeLabel', 'color', 'primaryColor', 'primaryTextColor'],
      ['.note', '.noteText', 'fill', 'noteBkgColor', 'noteTextColor'],
      ['.pieCircle', '.slice', 'fill', 'pie1', 'pieSectionTextColor'],
      [
        '.mindmap-node.section-root circle',
        '.mindmap-node.section-root p',
        'color',
        'git0',
        'gitBranchLabel0',
      ],
      [
        '.mindmap-node.section-0 path',
        '.mindmap-node.section-0 p',
        'color',
        'cScale1',
        'cScaleLabel1',
      ],
      [
        '.mindmap-node.section-1 path',
        '.mindmap-node.section-1 p',
        'color',
        'cScale2',
        'cScaleLabel2',
      ],
    ] as const) {
      const shape = canvasElement.querySelector(shapeSelector);
      const text = canvasElement.querySelector(textSelector);
      if (!(shape && text)) {
        throw new Error(`Missing themed chart elements: ${shapeSelector}`);
      }
      const fill = rgb(getComputedStyle(shape).fill);
      const foreground = rgb(getComputedStyle(text)[property]);
      await expect(fill).toEqual(rgb(config.themeVariables[fillToken]));
      await expect(foreground).toEqual(rgb(config.themeVariables[textToken]));
      await expect(contrastRatio(fill, foreground), shapeSelector).toBeGreaterThanOrEqual(
        threshold
      );
    }
  },
} satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FactoryLight: Story = { globals: { theme: 'light', colorScheme: 'factory' } };
export const FactoryDark: Story = { globals: { theme: 'dark', colorScheme: 'factory' } };
export const GitHubLight: Story = { globals: { theme: 'light', colorScheme: 'github' } };
export const GitHubDark: Story = { globals: { theme: 'dark', colorScheme: 'github' } };
export const OneLight: Story = { globals: { theme: 'light', colorScheme: 'one' } };
export const OneDark: Story = { globals: { theme: 'dark', colorScheme: 'one' } };
export const SolarizedLight: Story = { globals: { theme: 'light', colorScheme: 'solarized' } };
export const SolarizedDark: Story = { globals: { theme: 'dark', colorScheme: 'solarized' } };
export const HighContrastLight: Story = {
  globals: { theme: 'light', colorScheme: 'high-contrast' },
};
export const HighContrastDark: Story = { globals: { theme: 'dark', colorScheme: 'high-contrast' } };

function LiveTheme() {
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const original = root.style.getPropertyValue('--card');
    if (custom) {
      root.style.setProperty('--card', '#123456');
    }
    return () => {
      if (original) {
        root.style.setProperty('--card', original);
      } else {
        root.style.removeProperty('--card');
      }
    };
  }, [custom]);
  return (
    <>
      <Button onClick={() => setCustom(true)}>Apply custom surface</Button>
      <MermaidDiagram chart={charts[0] ?? ''} />
    </>
  );
}

export const LiveCustomColors: Story = {
  render: () => <LiveTheme />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('svg')).not.toBeNull());
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Apply custom surface' })
    );
    await waitFor(() =>
      expect(canvasElement.querySelector('svg')?.textContent).toContain('#123456')
    );
  },
};
