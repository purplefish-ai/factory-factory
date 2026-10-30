import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SubagentIcon } from './subagent-icon';

it('never repeats an icon, including beyond the botanical set', () => {
  const icons = Array.from({ length: 30 }, (_, index) =>
    renderToStaticMarkup(<SubagentIcon index={index} />)
  );
  expect(new Set(icons).size).toBe(30);
});
