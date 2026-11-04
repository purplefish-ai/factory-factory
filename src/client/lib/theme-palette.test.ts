import { describe, expect, it } from 'vitest';
import { readThemeDeclarations, resolveThemeVariables } from './theme-palette';

const CSS = `
:root {
  --brand: #111111; /* comment */
  --running: var(--brand);
}

.dark {
  --brand: #eeeeee;
}

:root[data-color-scheme='github'] {
  --brand: #0969da;
}

:root[data-color-scheme='github'].dark {
  --running: #d29922;
}
`;

describe('theme palette parsing', () => {
  it('follows the browser cascade and resolves var() references', () => {
    expect(resolveThemeVariables(CSS, 'factory', 'dark').get('--running')).toBe('#eeeeee');
    // The preset light block outranks .dark, so its brand applies in dark mode.
    expect(resolveThemeVariables(CSS, 'github', 'light').get('--running')).toBe('#0969da');
    expect(resolveThemeVariables(CSS, 'github', 'dark').get('--running')).toBe('#d29922');
  });

  it('matches a selector inside a selector list', () => {
    const css = `\n.a.dark,\n.a .dark {\n  --warning: #ffaa00;\n}\n`;
    expect(readThemeDeclarations(css, '.a .dark').get('--warning')).toBe('#ffaa00');
    expect(readThemeDeclarations(css, '.a.dark').get('--warning')).toBe('#ffaa00');
    expect(() => readThemeDeclarations(css, '.a')).toThrow('Theme block not found');
  });

  it('throws when a block is missing instead of reading nothing', () => {
    expect(() => readThemeDeclarations(CSS, ':root[data-color-scheme="github"]')).toThrow(
      'Theme block not found'
    );
  });

  it('throws on duplicate blocks that the browser would also apply', () => {
    expect(() =>
      readThemeDeclarations(`${CSS}\n.dark {\n  --brand: #000000;\n}\n`, '.dark')
    ).toThrow('Duplicate theme block');
  });
});
