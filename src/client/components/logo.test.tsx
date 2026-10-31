// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Logo, LogoIcon } from './logo';

it('keeps the icon decorative when the visible wordmark supplies the name', () => {
  const document = new DOMParser().parseFromString(renderToStaticMarkup(<Logo />), 'text/html');
  expect(document.querySelector('img')?.alt).toBe('');
  expect(document.body.textContent).toContain('Factory');
});

it('names the brand when the wordmark is hidden', () => {
  const document = new DOMParser().parseFromString(
    renderToStaticMarkup(<Logo showText={false} />),
    'text/html'
  );
  expect(document.querySelector('img')?.alt).toBe('Factory Factory');
});

it('names a standalone logo icon', () => {
  const document = new DOMParser().parseFromString(renderToStaticMarkup(<LogoIcon />), 'text/html');
  expect(document.querySelector('img')?.alt).toBe('Factory Factory');
});
