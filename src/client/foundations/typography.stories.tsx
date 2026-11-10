import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { MarkdownRenderer } from '@/client/components/markdown';
import { SectionLabel } from '@/client/components/section-label';
import { StatusChip } from '@/client/components/status-indicators';
import { contrastRatio, parseThemeColor } from '@/client/lib/color-contrast';
import { MarkdownRenderer as BaseMarkdownRenderer } from '@/components/ui/markdown';
import { COLOR_SCHEME_IDS } from '@/shared/appearance';

const CONTENT = [
  '# Theme-aware Markdown',
  '',
  'Readable prose with **strong text**, [the documentation](https://example.com), and `inline code`.',
  '',
  '> A quoted explanation.',
  '',
  '- An unordered item',
  '',
  '1. An ordered item',
  '',
  '```ts',
  'const appearance = "current";',
  '```',
  '',
  '---',
  '',
  '| Column | Value |',
  '| --- | --- |',
  '| Theme | Active |',
  '| Mode | Current |',
].join('\n');

function Typography() {
  return (
    <div className="max-w-3xl space-y-8">
      <section data-typography aria-label="Plain prose">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <h1>Theme-aware prose</h1>
          <p className="lead">An introduction.</p>
          <p>
            Readable prose with <strong>strong text</strong>,{' '}
            <a href="https://example.com">the documentation</a>, and <code>inline code</code>.
          </p>
          <blockquote>
            <p>A quoted explanation.</p>
          </blockquote>
          <ul>
            <li>An unordered item</li>
          </ul>
          <ol>
            <li>An ordered item</li>
          </ol>
          <pre>
            <code>const appearance = "current";</code>
          </pre>
          <p>
            <kbd>Enter</kbd>
          </p>
          <hr />
          <table>
            <thead>
              <tr>
                <th>Column</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Value</td>
              </tr>
              <tr>
                <td>Active</td>
              </tr>
            </tbody>
          </table>
          <figure>
            <figcaption>A descriptive caption.</figcaption>
          </figure>
        </div>
      </section>
      <section data-typography aria-label="Base Markdown">
        <BaseMarkdownRenderer content={CONTENT} />
      </section>
      <section data-typography aria-label="Application Markdown">
        <MarkdownRenderer content={CONTENT} />
      </section>
    </div>
  );
}

const meta = {
  title: 'Foundations/Typography',
  component: Typography,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Typography>;
export default meta;
type Story = StoryObj<typeof meta>;

type TokenColor = (name: string) => string;

async function assertColor(
  container: Element,
  selector: string,
  token: string,
  tokenColor: TokenColor,
  property = 'color'
) {
  const element = container.querySelector(selector);
  await expect(element, `${container.getAttribute('aria-label')}: ${selector}`).not.toBeNull();
  if (element) {
    await expect(getComputedStyle(element).getPropertyValue(property)).toBe(tokenColor(token));
  }
}

async function assertSectionColors(section: Element, tokenColor: TokenColor) {
  for (const selector of ['.prose', 'h1', 'strong', 'blockquote', 'p code', 'pre', 'th', 'td']) {
    await assertColor(section, selector, 'foreground', tokenColor);
  }
  await assertColor(section, 'a', 'primary', tokenColor);
  await assertColor(section, 'blockquote', 'border', tokenColor, 'border-inline-start-color');
  await assertColor(section, 'pre', 'muted', tokenColor, 'background-color');
  await assertColor(section, 'hr', 'border', tokenColor, 'border-top-color');
  for (const selector of ['thead', 'tbody tr:first-child']) {
    await assertColor(section, selector, 'border', tokenColor, 'border-bottom-color');
    await expect(getComputedStyle(section.querySelector(selector)!).borderBottomWidth).toBe('1px');
  }
  await expect(
    getComputedStyle(section.querySelector('tbody tr:last-child')!).borderBottomWidth
  ).toBe('0px');
}

async function assertPlainProseColors(plain: Element, tokenColor: TokenColor) {
  await assertColor(plain, '.lead', 'foreground', tokenColor);
  await assertColor(plain, 'kbd', 'foreground', tokenColor);
  await assertColor(plain, 'figcaption', 'muted-foreground', tokenColor);
  const keyboard = plain.querySelector('kbd');
  if (keyboard) {
    await expect(getComputedStyle(keyboard).boxShadow).not.toBe('none');
    await expect(getComputedStyle(keyboard).boxShadow).toContain(tokenColor('border'));
  }
  for (const list of ['ul', 'ol']) {
    const item = plain.querySelector(`${list} li`);
    await expect(item).not.toBeNull();
    if (item) {
      await expect(getComputedStyle(item, '::marker').color).toBe(tokenColor('muted-foreground'));
    }
  }
}

async function assertHighContrast(root: Element) {
  const styles = getComputedStyle(root);
  const foreground = parseThemeColor(styles.getPropertyValue('--foreground'));
  const background = parseThemeColor(styles.getPropertyValue('--background'));
  await expect(foreground).not.toBeNull();
  await expect(background).not.toBeNull();
  if (foreground && background) {
    await expect(contrastRatio(foreground.rgb, background.rgb)).toBeGreaterThanOrEqual(7);
  }
}

export const ThemeAware: Story = {
  play: async ({ canvasElement }) => {
    const root = document.documentElement;
    const originalClass = root.className;
    const originalScheme = root.getAttribute('data-color-scheme');
    const originalStyle = root.getAttribute('style');
    const probe = document.createElement('span');
    canvasElement.append(probe);
    const tokenColor: TokenColor = (name) => {
      probe.style.color = `var(--${name})`;
      return getComputedStyle(probe).color;
    };
    try {
      const sections = canvasElement.querySelectorAll('section[data-typography]');
      const plain = within(canvasElement).getByRole('region', { name: 'Plain prose' });
      for (const scheme of COLOR_SCHEME_IDS) {
        root.setAttribute('data-color-scheme', scheme);
        for (const mode of ['light', 'dark']) {
          root.classList.toggle('dark', mode === 'dark');
          for (const section of sections) {
            await assertSectionColors(section, tokenColor);
          }
          await assertPlainProseColors(plain, tokenColor);
          if (scheme === 'high-contrast') {
            await assertHighContrast(root);
          }
        }
      }
      root.style.setProperty('--foreground', '#abcdef');
      for (const section of sections) {
        await assertColor(section, '.prose', 'foreground', tokenColor);
      }
    } finally {
      root.className = originalClass;
      if (originalScheme === null) {
        root.removeAttribute('data-color-scheme');
      } else {
        root.setAttribute('data-color-scheme', originalScheme);
      }
      if (originalStyle === null) {
        root.removeAttribute('style');
      } else {
        root.setAttribute('style', originalStyle);
      }
      probe.remove();
    }
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
export const HighContrastLight: Story = {
  globals: { theme: 'light', colorScheme: 'high-contrast' },
};
export const HighContrastDark: Story = { globals: { theme: 'dark', colorScheme: 'high-contrast' } };

const TYPE_SCALE = [
  ['text-2xs', '11px / 14px: chips, section labels and dense metadata'],
  ['text-xs', '12px / 16px: secondary text, controls and badges'],
  ['text-sm', '14px / 20px: body text in panels and forms'],
  ['text-base', '16px / 24px: page body text'],
] as const;

/**
 * The app type scale. `text-2xs` is the one step below `text-xs`; arbitrary
 * sizes such as `text-[10px]` are rejected by factory/no-arbitrary-font-size.
 */
export const TypeScale: Story = {
  render: () => (
    <div className="max-w-2xl space-y-4">
      <SectionLabel asChild>
        <h2>Type scale</h2>
      </SectionLabel>
      <dl className="space-y-3">
        {TYPE_SCALE.map(([className, usage]) => (
          <div key={className} className="grid grid-cols-[8rem_1fr] items-baseline gap-4">
            <dt className="font-mono text-xs text-muted-foreground">{className}</dt>
            <dd data-type-step={className} className={className}>
              {usage}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2">
        <StatusChip tone="success">Passing</StatusChip>
        <StatusChip tone="working">Agent working</StatusChip>
        <SectionLabel>Section label</SectionLabel>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const step = canvasElement.querySelector('[data-type-step="text-2xs"]');
    await expect(step).not.toBeNull();
    if (step) {
      await expect(getComputedStyle(step).fontSize).toBe('11px');
      await expect(getComputedStyle(step).lineHeight).toBe('14px');
    }
  },
};
