import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from 'next-themes';
import type { CSSProperties } from 'react';
import { expect, within } from 'storybook/test';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { FileCode } from './file-code';
import { FileViewer } from './file-viewer';
import { WorkspacePanelProvider } from './workspace-panel-context';

const fontStyle: CSSProperties & { '--font-mono': string } = {
  '--font-mono': '"Atkinson Hyperlegible Mono", monospace',
};

function readFileResult(size: number) {
  return {
    content: 'export const greeting = "Hello, world!";\nconsole.log(greeting);',
    language: 'typescript',
    size,
    isBinary: false,
    truncated: size > 1024 ** 2,
  };
}

const meta = {
  title: 'Workspace/FileViewer',
  component: FileViewer,
  parameters: {
    layout: 'padded',
    trpc: { handlers: { 'workspace.readFile': () => readFileResult(73) } },
  },
  decorators: [
    (Story) => (
      <WorkspacePanelProvider workspaceId="file-viewer-story">
        <div className="h-80 w-full bg-background text-foreground" style={fontStyle}>
          <Story />
        </div>
      </WorkspacePanelProvider>
    ),
  ],
  args: {
    workspaceId: 'file-viewer-story',
    filePath: 'example.ts',
    tabId: 'file-example',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof FileViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccessibleMonospaceFont: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByText('greeting');
    const code = canvasElement.querySelector('code');
    await expect(code).not.toBeNull();
    await expect(code && getComputedStyle(code).fontFamily).toContain('Atkinson Hyperlegible Mono');
  },
};

export const DarkMonospaceFont: Story = {
  decorators: [
    (Story) => (
      <ThemeProvider attribute="class" forcedTheme="dark">
        <Story />
      </ThemeProvider>
    ),
  ],
  play: AccessibleMonospaceFont.play,
};

export const LargeSourceFile: Story = {
  render: () => (
    <div className="h-80 overflow-auto">
      <FileCode
        content={'/* multiline comment\ncontinues here */\nexport const greeting = "Hello";\n'.repeat(
          4000
        )}
        language="typescript"
        theme="dark"
      />
    </div>
  ),
};

export const MinifiedSourceFile: Story = {
  render: () => (
    <div className="h-80 overflow-auto">
      <FileCode content={`[${'{"x":1},'.repeat(124_998)}{"x":1}]`} language="json" theme="dark" />
    </div>
  ),
};

export const GigabyteFile: Story = {
  parameters: {
    trpc: { handlers: { 'workspace.readFile': () => readFileResult(1024 ** 3) } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('1.0 GB')).toBeVisible();
    await expect(canvas.getByText('File truncated to 1MB. Actual size: 1.0 GB')).toBeVisible();
  },
};

export const LoadingFile: Story = {
  parameters: { trpc: { handlers: { 'workspace.readFile': () => STORY_TRPC_PENDING } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Loading file…')).toBeVisible();
  },
};

export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'workspace.readFile': () => {
          throw new Error('ENOENT: no such file or directory');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Couldn't load file")).toBeVisible();
    await expect(canvas.getByText(/ENOENT: no such file or directory/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};

export const MarkdownPreview: Story = {
  args: { filePath: 'README.md' },
  parameters: {
    trpc: {
      handlers: {
        'workspace.readFile': () => ({
          content: '# Factory Factory\n\nPreviewed **Markdown**.',
          language: 'markdown',
          size: 42,
          isBinary: false,
          truncated: false,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Factory Factory' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Code' })).toBeVisible();
  },
};
