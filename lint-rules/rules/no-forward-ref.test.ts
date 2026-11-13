import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

describeRuleFixtures('no-forward-ref', {
  rejected: [
    'const Item = forwardRef(function Item(props, ref) { return null; });',
    'const Item = React.forwardRef((props, ref) => null);',
  ],
  accepted: ['function Item({ ref }) { return <button ref={ref} />; }'],
});

describe('forwardRef restriction', () => {
  const projectConfig = readProjectConfig();

  it('applies everywhere except the shadcn/ui primitives', () => {
    expect(projectConfig.rules['factory/no-forward-ref']).toBe('error');
    expect(
      projectConfig.overrides
        .filter((override) => override.rules['factory/no-forward-ref'] !== undefined)
        .map((override) => [override.files, override.rules['factory/no-forward-ref']])
    ).toEqual([[['src/components/ui/**/*.{ts,tsx}'], 'off']]);
  });
});
