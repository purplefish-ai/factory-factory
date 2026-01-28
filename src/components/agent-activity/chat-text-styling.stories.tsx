'use client';

import type { Meta, StoryObj } from '@storybook/react';
import type * as React from 'react';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { cn } from '@/lib/utils';

// Sample content to display - mix of prose, code, and lists
const SAMPLE_MARKDOWN = `Here's a summary of what I found in the codebase:

The authentication system uses JWT tokens stored in HTTP-only cookies. The main entry point is \`src/auth/middleware.ts\` which validates tokens on each request.

**Key files:**
- \`src/auth/middleware.ts\` - Token validation
- \`src/auth/providers/oauth.ts\` - OAuth provider integration
- \`src/lib/session.ts\` - Session management

Here's how the token refresh works:

\`\`\`typescript
async function refreshToken(token: string) {
  const decoded = jwt.verify(token, SECRET);
  if (decoded.exp < Date.now() / 1000) {
    return generateNewToken(decoded.userId);
  }
  return token;
}
\`\`\`

The system handles three authentication states:
1. **Authenticated** - Valid token present
2. **Expired** - Token needs refresh
3. **Unauthenticated** - No token or invalid

Let me know if you want me to look at any specific part in more detail.`;

const SHORT_MESSAGE = `I'll read the file to understand the current implementation.`;

const MEDIUM_MESSAGE = `I found the issue. The \`handleSubmit\` function isn't properly awaiting the async validation. This causes the form to submit before validation completes.

I'll fix this by adding \`await\` before the \`validateForm()\` call.`;

// Configurable text container component
interface ChatTextStylerProps {
  content: string;
  // Font settings
  fontSize: 'text-xs' | 'text-sm' | 'text-base' | 'text-lg';
  fontFamily: 'font-sans' | 'font-mono' | 'font-serif';
  fontWeight: 'font-normal' | 'font-medium' | 'font-semibold';
  // Spacing
  lineHeight:
    | 'leading-tight'
    | 'leading-snug'
    | 'leading-normal'
    | 'leading-relaxed'
    | 'leading-loose';
  letterSpacing: 'tracking-tighter' | 'tracking-tight' | 'tracking-normal' | 'tracking-wide';
  paragraphSpacing: 'space-y-1' | 'space-y-2' | 'space-y-3' | 'space-y-4';
  // Prose settings
  proseSize: 'prose-sm' | 'prose-base' | 'prose-lg';
  // Container padding
  padding: 'p-0' | 'p-2' | 'p-3' | 'p-4';
  // Custom CSS (for experimentation)
  customCss?: string;
  // Background for contrast
  showBackground?: boolean;
}

function ChatTextStyler({
  content,
  fontSize,
  fontFamily,
  fontWeight,
  lineHeight,
  letterSpacing,
  paragraphSpacing,
  proseSize,
  padding,
  customCss,
  showBackground = false,
}: ChatTextStylerProps) {
  return (
    <div
      className={cn(
        'max-w-2xl rounded-md',
        showBackground && 'bg-muted/30 border border-border',
        padding
      )}
    >
      <div
        className={cn(
          'prose dark:prose-invert max-w-none break-words',
          proseSize,
          fontSize,
          fontFamily,
          fontWeight,
          lineHeight,
          letterSpacing,
          customCss
        )}
        style={
          {
            // Override prose defaults with our settings
            '--tw-prose-body': 'inherit',
          } as React.CSSProperties
        }
      >
        <div className={paragraphSpacing}>
          <MarkdownRenderer content={content} className={cn(fontSize, lineHeight)} />
        </div>
      </div>
    </div>
  );
}

// Comparison view to see multiple settings side by side
interface ComparisonViewProps {
  content: string;
  variants: Array<{
    label: string;
    fontSize: ChatTextStylerProps['fontSize'];
    lineHeight: ChatTextStylerProps['lineHeight'];
    proseSize: ChatTextStylerProps['proseSize'];
  }>;
}

function ComparisonView({ content, variants }: ComparisonViewProps) {
  return (
    <div className="grid gap-6">
      {variants.map((variant) => (
        <div key={variant.label} className="border-b border-border pb-6 last:border-0">
          <div className="text-xs text-muted-foreground mb-2 font-mono">
            {variant.label} | {variant.fontSize} | {variant.lineHeight} | {variant.proseSize}
          </div>
          <ChatTextStyler
            content={content}
            fontSize={variant.fontSize}
            fontFamily="font-sans"
            fontWeight="font-normal"
            lineHeight={variant.lineHeight}
            letterSpacing="tracking-normal"
            paragraphSpacing="space-y-2"
            proseSize={variant.proseSize}
            padding="p-0"
          />
        </div>
      ))}
    </div>
  );
}

// Main story component
const meta = {
  title: 'AgentActivity/ChatTextStyling',
  component: ChatTextStyler,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: `
Experiment with chat text styling parameters to find the right balance of readability and density.

**Current production values:**
- Font size: \`text-xs\` (12px)
- Line height: (prose default ~1.5)
- Prose size: \`prose-sm\`

**Controls to experiment with:**
- Font size: xs (12px) → sm (14px) → base (16px) → lg (18px)
- Line height: tight (1.25) → snug (1.375) → normal (1.5) → relaxed (1.625) → loose (2)
- Letter spacing: tighter → tight → normal → wide
- Paragraph spacing: space-y-1 → space-y-4
        `,
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    content: {
      control: 'text',
      description: 'Markdown content to render',
    },
    fontSize: {
      control: 'select',
      options: ['text-xs', 'text-sm', 'text-base', 'text-lg'],
      description: 'Base font size (xs=12px, sm=14px, base=16px, lg=18px)',
    },
    fontFamily: {
      control: 'select',
      options: ['font-sans', 'font-mono', 'font-serif'],
      description: 'Font family',
    },
    fontWeight: {
      control: 'select',
      options: ['font-normal', 'font-medium', 'font-semibold'],
      description: 'Font weight',
    },
    lineHeight: {
      control: 'select',
      options: [
        'leading-tight',
        'leading-snug',
        'leading-normal',
        'leading-relaxed',
        'leading-loose',
      ],
      description: 'Line height (tight=1.25, snug=1.375, normal=1.5, relaxed=1.625, loose=2)',
    },
    letterSpacing: {
      control: 'select',
      options: ['tracking-tighter', 'tracking-tight', 'tracking-normal', 'tracking-wide'],
      description: 'Letter spacing',
    },
    paragraphSpacing: {
      control: 'select',
      options: ['space-y-1', 'space-y-2', 'space-y-3', 'space-y-4'],
      description: 'Vertical spacing between paragraphs',
    },
    proseSize: {
      control: 'select',
      options: ['prose-sm', 'prose-base', 'prose-lg'],
      description: 'Tailwind prose size preset',
    },
    padding: {
      control: 'select',
      options: ['p-0', 'p-2', 'p-3', 'p-4'],
      description: 'Container padding',
    },
    showBackground: {
      control: 'boolean',
      description: 'Show background for contrast',
    },
  },
} satisfies Meta<typeof ChatTextStyler>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Default (Current Production Settings)
// =============================================================================

/**
 * Current production settings for reference.
 * This is what the chat currently looks like.
 */
export const CurrentProduction: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-xs',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-normal',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
    showBackground: false,
  },
};

// =============================================================================
// Larger & More Readable Variants
// =============================================================================

/**
 * Slightly larger text with more line height.
 * A good middle ground between current and truly "readable".
 */
export const SlightlyLarger: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
    showBackground: false,
  },
};

/**
 * Base size text - standard web reading size.
 */
export const BaseSize: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-base',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-3',
    proseSize: 'prose-base',
    padding: 'p-0',
    showBackground: false,
  },
};

/**
 * More generous spacing - easier on the eyes for longer reading.
 */
export const Airy: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-loose',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-4',
    proseSize: 'prose-base',
    padding: 'p-0',
    showBackground: false,
  },
};

// =============================================================================
// Font Family Variants
// =============================================================================

/**
 * Monospace font - more "terminal" feel.
 */
export const Monospace: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-mono',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
    showBackground: false,
  },
};

// =============================================================================
// Comparison Stories
// =============================================================================

/**
 * Side-by-side comparison of font sizes.
 */
export const FontSizeComparison: Story = {
  args: {
    content: MEDIUM_MESSAGE,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-normal',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
  },
  render: () => (
    <ComparisonView
      content={MEDIUM_MESSAGE}
      variants={[
        {
          label: 'Current (xs)',
          fontSize: 'text-xs',
          lineHeight: 'leading-normal',
          proseSize: 'prose-sm',
        },
        {
          label: 'Small (sm)',
          fontSize: 'text-sm',
          lineHeight: 'leading-normal',
          proseSize: 'prose-sm',
        },
        {
          label: 'Base',
          fontSize: 'text-base',
          lineHeight: 'leading-normal',
          proseSize: 'prose-base',
        },
        {
          label: 'Large (lg)',
          fontSize: 'text-lg',
          lineHeight: 'leading-normal',
          proseSize: 'prose-lg',
        },
      ]}
    />
  ),
};

/**
 * Side-by-side comparison of line heights.
 */
export const LineHeightComparison: Story = {
  args: {
    content: MEDIUM_MESSAGE,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-normal',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
  },
  render: () => (
    <ComparisonView
      content={MEDIUM_MESSAGE}
      variants={[
        {
          label: 'Tight (1.25)',
          fontSize: 'text-sm',
          lineHeight: 'leading-tight',
          proseSize: 'prose-sm',
        },
        {
          label: 'Snug (1.375)',
          fontSize: 'text-sm',
          lineHeight: 'leading-snug',
          proseSize: 'prose-sm',
        },
        {
          label: 'Normal (1.5)',
          fontSize: 'text-sm',
          lineHeight: 'leading-normal',
          proseSize: 'prose-sm',
        },
        {
          label: 'Relaxed (1.625)',
          fontSize: 'text-sm',
          lineHeight: 'leading-relaxed',
          proseSize: 'prose-sm',
        },
        {
          label: 'Loose (2)',
          fontSize: 'text-sm',
          lineHeight: 'leading-loose',
          proseSize: 'prose-sm',
        },
      ]}
    />
  ),
};

/**
 * Recommended alternatives - a few hand-picked combinations to consider.
 */
export const RecommendedAlternatives: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-normal',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
  },
  render: () => (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold mb-2">Option A: Minimal Change</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Just bump to text-sm (14px) - keeps density but improves readability
        </p>
        <div className="border border-border rounded-md p-4">
          <ChatTextStyler
            content={SAMPLE_MARKDOWN}
            fontSize="text-sm"
            fontFamily="font-sans"
            fontWeight="font-normal"
            lineHeight="leading-normal"
            letterSpacing="tracking-normal"
            paragraphSpacing="space-y-2"
            proseSize="prose-sm"
            padding="p-0"
          />
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-2">Option B: More Breathing Room</h3>
        <p className="text-xs text-muted-foreground mb-4">
          text-sm + leading-relaxed - better for longer messages
        </p>
        <div className="border border-border rounded-md p-4">
          <ChatTextStyler
            content={SAMPLE_MARKDOWN}
            fontSize="text-sm"
            fontFamily="font-sans"
            fontWeight="font-normal"
            lineHeight="leading-relaxed"
            letterSpacing="tracking-normal"
            paragraphSpacing="space-y-3"
            proseSize="prose-sm"
            padding="p-0"
          />
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-2">Option C: Standard Web</h3>
        <p className="text-xs text-muted-foreground mb-4">
          text-base (16px) - standard web reading size, most accessible
        </p>
        <div className="border border-border rounded-md p-4">
          <ChatTextStyler
            content={SAMPLE_MARKDOWN}
            fontSize="text-base"
            fontFamily="font-sans"
            fontWeight="font-normal"
            lineHeight="leading-relaxed"
            letterSpacing="tracking-normal"
            paragraphSpacing="space-y-3"
            proseSize="prose-base"
            padding="p-0"
          />
        </div>
      </div>
    </div>
  ),
};

// =============================================================================
// Short vs Long Content
// =============================================================================

/**
 * Test with a short message to see how it looks.
 */
export const ShortMessage: Story = {
  args: {
    content: SHORT_MESSAGE,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
    showBackground: true,
  },
};

/**
 * Test with the full long markdown content.
 */
export const LongMessage: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-0',
    showBackground: true,
  },
};

// =============================================================================
// Interactive Playground
// =============================================================================

/**
 * Full interactive playground - use the controls panel to experiment.
 */
export const Playground: Story = {
  args: {
    content: SAMPLE_MARKDOWN,
    fontSize: 'text-sm',
    fontFamily: 'font-sans',
    fontWeight: 'font-normal',
    lineHeight: 'leading-relaxed',
    letterSpacing: 'tracking-normal',
    paragraphSpacing: 'space-y-2',
    proseSize: 'prose-sm',
    padding: 'p-3',
    showBackground: true,
  },
};
