import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RatchetWrenchIcon } from './ratchet-wrench-icon';

function pathData(markup: string): string[] {
  return [...markup.matchAll(/<path d="([^"]+)"/g)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
}

describe('RatchetWrenchIcon', () => {
  it('uses visible regular and filled Phosphor weights for its states', () => {
    const disabledMarkup = renderToStaticMarkup(<RatchetWrenchIcon enabled={false} />);
    const enabledMarkup = renderToStaticMarkup(<RatchetWrenchIcon enabled />);

    expect(disabledMarkup).not.toContain('fill="none"');
    expect(pathData(disabledMarkup)).not.toEqual(pathData(enabledMarkup));
  });
});
