import type { Meta, StoryObj } from '@storybook/react';
import { contrastRatio, mixOver, type Rgb } from '@/client/lib/color-contrast';
import { type RenderedToken, useRenderedTokens } from './rendered-colors';

interface TokenGroup {
  title: string;
  description: string;
  /**
   * Each token, with the token its text sits on (for the contrast readout).
   * `darkFillAlpha` mirrors fills that components render translucently in dark mode.
   */
  tokens: { name: string; on?: string; darkFillAlpha?: number }[];
}

const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: 'Surfaces and text',
    description: 'Page, card and control surfaces with their text colors.',
    tokens: [
      { name: 'background' },
      { name: 'foreground', on: 'background' },
      { name: 'card' },
      { name: 'card-foreground', on: 'card' },
      { name: 'popover' },
      { name: 'popover-foreground', on: 'popover' },
      { name: 'primary' },
      { name: 'primary-foreground', on: 'primary' },
      { name: 'secondary' },
      { name: 'secondary-foreground', on: 'secondary' },
      { name: 'muted' },
      { name: 'muted-foreground', on: 'background' },
      { name: 'accent' },
      { name: 'accent-foreground', on: 'accent' },
      { name: 'border' },
      { name: 'input' },
      { name: 'ring', on: 'background' },
    ],
  },
  {
    title: 'Brand',
    description:
      'Factory Yellow. Dark mode uses #FFE500; light mode darkens the same hue so it reads as text.',
    tokens: [
      { name: 'brand', on: 'background' },
      { name: 'brand-foreground', on: 'brand' },
    ],
  },
  {
    title: 'Status',
    description:
      'Base tokens are text colors on the background and their own tint; *-foreground is text on a solid fill.',
    tokens: [
      { name: 'running', on: 'background' },
      { name: 'running-foreground', on: 'running' },
      { name: 'success', on: 'background' },
      { name: 'success-foreground', on: 'success' },
      { name: 'warning', on: 'background' },
      { name: 'warning-foreground', on: 'warning' },
      { name: 'destructive', on: 'background' },
      // shadcn Button and Badge render destructive at 60% in dark mode.
      { name: 'destructive-foreground', on: 'destructive', darkFillAlpha: 0.6 },
      { name: 'info', on: 'background' },
      { name: 'info-foreground', on: 'info' },
      { name: 'merged', on: 'background' },
      { name: 'merged-foreground', on: 'merged' },
    ],
  },
  {
    title: 'Charts',
    description: 'Data visualization series.',
    tokens: [1, 2, 3, 4, 5].map((index) => ({ name: `chart-${index}`, on: 'background' })),
  },
  {
    title: 'Sidebar',
    description: 'Navigation sidebar surfaces.',
    tokens: [
      { name: 'sidebar' },
      { name: 'sidebar-foreground', on: 'sidebar' },
      { name: 'sidebar-primary' },
      { name: 'sidebar-primary-foreground', on: 'sidebar-primary' },
      { name: 'sidebar-accent' },
      { name: 'sidebar-accent-foreground', on: 'sidebar-accent' },
      { name: 'sidebar-border' },
      { name: 'sidebar-ring', on: 'sidebar' },
    ],
  },
];

const ALL_TOKENS = TOKEN_GROUPS.flatMap((group) => group.tokens.map((token) => token.name));

function ContrastLabel({
  foreground,
  background,
}: {
  foreground: Rgb | null | undefined;
  background: Rgb | null | undefined;
}) {
  if (!(foreground && background)) {
    return null;
  }
  const ratio = contrastRatio(foreground, background);
  return (
    <span className={ratio >= 4.5 ? 'text-muted-foreground' : 'font-semibold text-destructive'}>
      {ratio.toFixed(2)}:1{ratio >= 4.5 ? '' : ' (below AA)'}
    </span>
  );
}

type ColorToken = TokenGroup['tokens'][number];

/**
 * Translucent fills are layered over the page the way `bg-<token>/60` renders
 * (sRGB alpha compositing), so the swatch matches the measured `mixOver` ratio.
 */
function swatchBackground(token: ColorToken, fillAlpha: number | undefined): string {
  if (!token.on) {
    return `var(--${token.name})`;
  }
  if (!fillAlpha) {
    return `var(--${token.on})`;
  }
  const fill = `color-mix(in oklab, var(--${token.on}) ${fillAlpha * 100}%, transparent)`;
  return `linear-gradient(${fill}, ${fill}), var(--background)`;
}

function TokenSwatch({
  token,
  resolved,
  dark,
}: {
  token: ColorToken;
  resolved: ReadonlyMap<string, RenderedToken>;
  dark: boolean;
}) {
  const rendered = resolved.get(token.name);
  const fillAlpha = dark ? token.darkFillAlpha : undefined;
  const onRgb = token.on ? resolved.get(token.on)?.rgb : null;
  const pageBackground = resolved.get('background')?.rgb;
  const background =
    onRgb && fillAlpha && pageBackground ? mixOver(onRgb, pageBackground, fillAlpha) : onRgb;
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div
        className="flex h-14 items-end p-2 text-xs font-medium"
        style={{
          background: swatchBackground(token, fillAlpha),
          color: token.on ? `var(--${token.name})` : undefined,
        }}
      >
        {token.on ? 'Aa Sample text' : null}
      </div>
      <div className="space-y-0.5 p-2 text-xs">
        <div className="font-mono font-medium">--{token.name}</div>
        <div className="truncate font-mono text-muted-foreground" title={rendered?.value}>
          {rendered?.value || '—'}
        </div>
        {token.on && (
          <div>
            on --{token.on}
            {fillAlpha ? ` at ${fillAlpha * 100}%` : ''}:{' '}
            <ContrastLabel foreground={rendered?.rgb} background={background} />
          </div>
        )}
      </div>
    </div>
  );
}

function ColorTokens({ dark = false }: { dark?: boolean }) {
  const { ref, resolved } = useRenderedTokens(ALL_TOKENS);
  return (
    <div ref={ref} className="max-w-5xl space-y-8 bg-background p-6 text-foreground">
      {TOKEN_GROUPS.map((group) => (
        <section key={group.title} className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{group.title}</h2>
            <p className="text-sm text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {group.tokens.map((token) => (
              <TokenSwatch key={token.name} token={token} resolved={resolved} dark={dark} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: 'Foundations/Colors',
  component: ColorTokens,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Every theme token with its rendered value and contrast. Switch Theme and Color scheme in the toolbar to inspect each preset. See docs/status-colors.md.',
      },
    },
  },
  // Remount on theme changes so the readout re-measures the rendered colors.
  render: (_args, { globals }) => (
    <ColorTokens key={`${globals.theme}-${globals.colorScheme}`} dark={globals.theme === 'dark'} />
  ),
} satisfies Meta<typeof ColorTokens>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { globals: { theme: 'light' } };

export const Dark: Story = { globals: { theme: 'dark' } };
