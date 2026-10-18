import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor } from 'storybook/test';
import { FileCode } from './file-code';

const meta = {
  title: 'Workspace/FileCode',
  component: FileCode,
  parameters: { layout: 'padded' },
  args: {
    theme: 'light',
    language: 'typescript',
    content:
      '// Preserves indentation, tabs, empty lines and the final newline.\nexport const greeting = "Hello, world!";\n\n\tconsole.log(greeting);\n',
  },
  decorators: [
    (Story, { args }) => (
      <div
        style={
          {
            maxWidth: 800,
            height: 360,
            overflow: 'auto',
            background: args.theme === 'dark' ? '#282c34' : '#fafafa',
            '--font-mono': 'monospace',
            '--muted-foreground': '#888',
          } as React.CSSProperties
        }
      >
        <Story />
      </div>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof FileCode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.token.keyword')).not.toBeNull());
    await expect(getComputedStyle(canvasElement.querySelector('.token.keyword')!).color).toBe(
      'rgb(166, 38, 164)'
    );
    await expect(canvasElement.querySelector('.token[style]')).toBeNull();
  },
};

export const Dark: Story = {
  args: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.token.keyword')).not.toBeNull());
    await expect(getComputedStyle(canvasElement.querySelector('.token.keyword')!).color).toBe(
      'rgb(198, 120, 221)'
    );
  },
};

export const LongLines: Story = {
  args: {
    content: `const longMessage = "${'Long source text '.repeat(70)}";\nconsole.log(longMessage);\n`,
  },
};

export const ThousandLines: Story = {
  args: {
    content: Array.from(
      { length: 1000 },
      (_, index) => `export const value${index} = "line ${index + 1}";`
    ).join('\n'),
  },
};

export const UnsupportedLanguage: Story = {
  args: {
    language: 'unknown-language',
    content: '<literal source>\n  Keeps whitespace & special characters.\n',
  },
};

export const CSS: Story = {
  args: {
    language: 'css',
    content:
      '/* Language-specific One Light selectors */\n.example { color: red !important; background: url("image.png"); }',
  },
};

export const Markup: Story = {
  args: {
    language: 'markup',
    content: '<a href="https://example.com" class="example">Link &amp; text</a>',
  },
};

export const JSONSource: Story = {
  args: {
    language: 'json',
    content: '{\n  "enabled": true,\n  "count": 42,\n  "value": null\n}\n',
  },
};

export const MarkdownSource: Story = {
  args: {
    language: 'markdown',
    content:
      '# Heading\n\n**Bold** and *italic*, ~~struck~~.\n\n> Quoted text\n\n[Link](https://example.com)\n\n- List item\n',
  },
};
