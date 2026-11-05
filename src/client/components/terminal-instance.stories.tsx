import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { contrastRatio, parseThemeColor } from '@/client/lib/color-contrast';
import { Button } from '@/components/ui/button';
import { COLOR_SCHEME_IDS } from '@/shared/appearance';
import { TerminalInstance } from './terminal-instance';
import { readTerminalTheme } from './terminal-theme';

const meta = {
  title: 'Workspace/TerminalInstance',
  component: TerminalInstance,
  parameters: { layout: 'centered' },
  args: { onData: () => undefined, onResize: () => undefined },
} satisfies Meta<typeof TerminalInstance>;

export default meta;
type Story = StoryObj<typeof meta>;

function ReplayPreview({ truncated = false }: { truncated?: boolean }) {
  const [replayed, setReplayed] = useState(false);
  const before = '$ pnpm test\r\nRunning 12 tests...\r\n';
  const after = truncated
    ? 'Older output has rolled out of the buffer.\r\n12 passed (12)\r\n$ '
    : `${before}12 passed (12)\r\n$ `;
  return (
    <div className="w-[700px] space-y-3">
      <p className="text-sm text-muted-foreground">
        {replayed ? 'Reconnected: server output restored.' : 'Disconnected while tests finish.'}
      </p>
      <Button onClick={() => setReplayed(!replayed)}>
        {replayed ? 'Reset preview' : 'Replay reconnect buffer'}
      </Button>
      <div className="h-[280px] overflow-hidden rounded border bg-background">
        <TerminalInstance
          output={replayed ? after : before}
          onData={() => undefined}
          onResize={() => undefined}
          className="h-full"
        />
      </div>
    </div>
  );
}

export const ReconnectReplay: Story = {
  args: { output: '' },
  render: () => <ReplayPreview />,
};

export const RollingWindowReplay: Story = {
  args: { output: '' },
  render: () => <ReplayPreview truncated />,
};

const ANSI_OUTPUT = [
  '$ terminal palette',
  '\x1b[31mRed: failed\x1b[0m  \x1b[32mGreen: passed\x1b[0m  \x1b[33mYellow: caution\x1b[0m',
  '\x1b[34mBlue\x1b[0m  \x1b[35mMagenta\x1b[0m  \x1b[36mCyan\x1b[0m',
  '\x1b[90mMuted\x1b[0m  \x1b[91mBright red\x1b[0m  \x1b[92mBright green\x1b[0m',
  '\x1b[93mBright yellow\x1b[0m  \x1b[94mBright blue\x1b[0m  \x1b[95mBright magenta\x1b[0m  \x1b[96mBright cyan\x1b[0m',
  'Select this text to check selection contrast. Theme changes preserve this output.',
  '$ ',
].join('\r\n');

export const ThemePalette: Story = {
  args: { output: ANSI_OUTPUT },
  render: (args) => (
    <div className="h-[280px] w-[700px]">
      <TerminalInstance {...args} />
    </div>
  ),
};

export const LightPalette: Story = {
  ...ThemePalette,
  globals: { theme: 'light' },
};

export const DarkPalette: Story = {
  ...ThemePalette,
  globals: { theme: 'dark' },
};

export const HighContrastPalette: Story = {
  ...ThemePalette,
  globals: { theme: 'dark', colorScheme: 'high-contrast' },
};

export const LiveThemeSwitch: Story = {
  args: { output: ANSI_OUTPUT },
  render: (args) => (
    <div className="w-[700px] space-y-3">
      <Button onClick={() => document.documentElement.classList.toggle('dark')}>
        Switch terminal theme
      </Button>
      <div className="h-[280px]">
        <TerminalInstance {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const root = document.documentElement;
    const initialClass = root.className;
    const initialScheme = root.getAttribute('data-color-scheme');
    await waitFor(async () => {
      await expect(canvasElement.querySelector('.xterm-viewport')).not.toBeNull();
    });
    const viewport = canvasElement.querySelector('.xterm-scrollable-element');
    const screen = canvasElement.querySelector('.xterm-screen');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error('Terminal viewport is missing');
    }
    try {
      const initialBackground = getComputedStyle(viewport).backgroundColor;
      await userEvent.click(
        within(canvasElement).getByRole('button', { name: 'Switch terminal theme' })
      );
      await waitFor(async () => {
        await expect(getComputedStyle(viewport).backgroundColor).not.toBe(initialBackground);
      });
      await expect(canvasElement.querySelector('.xterm-screen')).toBe(screen);
      // Exercise every computed palette in a real browser, including OKLCH,
      // aliases and the preset override cascade. xterm also adjusts any ANSI
      // text that falls below its configured minimum contrast.
      for (const scheme of COLOR_SCHEME_IDS) {
        root.setAttribute('data-color-scheme', scheme);
        for (const dark of [false, true]) {
          root.classList.toggle('dark', dark);
          const palette = readTerminalTheme();
          const background = parseThemeColor(palette.background ?? '')!;
          const foreground = parseThemeColor(palette.foreground ?? '')!;
          await expect(contrastRatio(foreground.rgb, background.rgb)).toBeGreaterThanOrEqual(
            scheme === 'high-contrast' ? 7 : 4.5
          );
          for (const slot of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
            await expect(palette[slot]).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
      }
    } finally {
      root.className = initialClass;
      if (initialScheme === null) {
        root.removeAttribute('data-color-scheme');
      } else {
        root.setAttribute('data-color-scheme', initialScheme);
      }
    }
  },
};

function FocusPreview() {
  const [visible, setVisible] = useState(false);
  return (
    <div className="w-[700px] space-y-3">
      <label className="block">
        Workspace prompt
        <input aria-label="Workspace prompt" className="block border p-2" />
      </label>
      <Button onClick={() => setVisible(!visible)}>Toggle workspace terminal</Button>
      <div className="h-[280px] border">
        {visible && (
          <TerminalInstance output="$ ready" onData={() => undefined} onResize={() => undefined} />
        )}
      </div>
    </div>
  );
}

export const ManualFocus: Story = {
  args: { output: '' },
  render: () => <FocusPreview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Toggle workspace terminal' });
    await userEvent.click(toggle);
    await waitFor(async () => {
      await expect(canvasElement.querySelector('.xterm-helper-textarea')).not.toBeNull();
    });
    await expect(toggle).toHaveFocus();
    await userEvent.click(canvas.getByRole('application', { name: 'Terminal' }));
    await expect(canvasElement.querySelector('.xterm-helper-textarea')).toHaveFocus();
  },
};
