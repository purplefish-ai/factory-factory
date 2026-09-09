import type { Meta, StoryObj } from '@storybook/react';
import { type RefObject, useRef, useState } from 'react';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button } from '@/components/ui/button';
import { calculateLineNumberWidth, parseDetailedDiff } from '@/lib/diff/parse';
import type { DiffLine } from '@/lib/diff/types';
import { DiffLines } from './diff-lines';
import type { ScrollState } from './scroll-state';
import { useDiffHighlighting } from './use-diff-highlighting';

function DiffStoryContent({
  lines,
  theme,
  saved,
}: {
  lines: DiffLine[];
  theme: string;
  saved: RefObject<ScrollState | null>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const tokens = useDiffHighlighting(lines, 'typescript', theme === 'dark' ? oneDark : oneLight);
  return (
    <div
      ref={viewport}
      className="h-[480px] w-full max-w-4xl overflow-auto border rounded bg-background text-foreground"
    >
      <DiffLines
        lines={lines}
        lineNumberWidth={calculateLineNumberWidth(lines)}
        tokenMap={tokens}
        scrollContainerRef={viewport}
        scrollState={saved.current}
        onScrollStateChange={(state) => {
          saved.current = state;
        }}
      />
    </div>
  );
}

function DiffStory({ lines, theme = 'light' }: { lines: DiffLine[]; theme?: string }) {
  const saved = useRef<ScrollState | null>(null);
  const [visible, setVisible] = useState(true);
  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={() => setVisible((value) => !value)}>
        {visible ? 'Hide diff' : 'Show diff'}
      </Button>
      {visible && <DiffStoryContent lines={lines} theme={theme} saved={saved} />}
    </div>
  );
}

const meta = {
  title: 'Workspace/DiffLines',
  component: DiffStory,
  render: (args, context) => (
    <DiffStory {...args} theme={context.globals.theme === 'dark' ? 'dark' : 'light'} />
  ),
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DiffStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SmallDiff: Story = {
  args: {
    lines: parseDetailedDiff(
      '@@ -1,3 +1,3 @@\n export function greet() {\n-  return "Hello";\n+  return "Welcome";\n }'
    ),
  },
};

export const LargeDiff: Story = {
  args: {
    lines: parseDetailedDiff(
      `@@ -0,0 +1,10000 @@\n${Array.from({ length: 10_000 }, (_, i) => `+export const value${i} = { label: "Row ${i}", enabled: true };`).join('\n')}`
    ),
  },
};

export const WrappedLines: Story = {
  args: {
    lines: parseDetailedDiff(
      `@@ -0,0 +1,1000 @@\n${Array.from({ length: 1000 }, (_, i) => `+const value${i} = "${'A long line that wraps across the viewport. '.repeat((i % 5) + 1)}";`).join('\n')}`
    ),
  },
};
