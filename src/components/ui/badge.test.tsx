import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getStatusToneStyle } from '@/client/lib/status-tones';
import { Badge } from './badge';

describe('Badge', () => {
  it('sizes counts as a compact, centered pill with tabular figures', () => {
    const markup = renderToStaticMarkup(
      <Badge variant="secondary" size="count">
        12
      </Badge>
    );
    for (const className of ['h-5', 'min-w-5', 'px-1.5', 'tabular-nums', 'text-xs']) {
      expect(markup).toContain(className);
    }
    expect(markup).not.toContain('px-2.5');
  });

  it.each([
    ['success', 'success'],
    ['warning', 'warning'],
    ['info', 'info'],
    ['danger', 'danger'],
  ] as const)('tints the %s variant with the %s status chip classes', (variant, tone) => {
    const markup = renderToStaticMarkup(<Badge variant={variant}>3</Badge>);
    for (const className of getStatusToneStyle(tone).chip.split(' ')) {
      expect(markup).toContain(className);
    }
  });
});
