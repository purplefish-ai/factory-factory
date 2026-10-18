import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { ThemeProvider } from 'next-themes';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { expect, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { FileCode, FileViewer } from './file-viewer';
import { WorkspacePanelProvider } from './workspace-panel-context';

const fontStyle: CSSProperties & { '--font-mono': string } = {
  '--font-mono': '"Atkinson Hyperlegible Mono", monospace',
};

function FileViewerStoryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.next({
              result: {
                data: {
                  content: 'export const greeting = "Hello, world!";\nconsole.log(greeting);',
                  language: 'typescript',
                  size: 73,
                  isBinary: false,
                  truncated: false,
                },
              },
            });
            observer.complete();
          }),
      ],
    })
  );

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId="file-viewer-story">
          <div className="h-80 w-full bg-background text-foreground" style={fontStyle}>
            {children}
          </div>
        </WorkspacePanelProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Workspace/FileViewer',
  component: FileViewer,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <FileViewerStoryProvider>
        <Story />
      </FileViewerStoryProvider>
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

const largeSourceTheme = { comment: { color: 'gray' }, keyword: { color: 'purple' } };

export const LargeSourceFile: Story = {
  render: () => (
    <div className="h-80 overflow-auto">
      <FileCode
        content={'/* multiline comment\ncontinues here */\nexport const greeting = "Hello";\n'.repeat(
          4000
        )}
        language="typescript"
        theme={largeSourceTheme}
      />
    </div>
  ),
};

export const MinifiedSourceFile: Story = {
  render: () => (
    <div className="h-80 overflow-auto">
      <FileCode
        content={`[${'{"x":1},'.repeat(124_998)}{"x":1}]`}
        language="json"
        theme={largeSourceTheme}
      />
    </div>
  ),
};
