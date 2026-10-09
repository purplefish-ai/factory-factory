import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PRUpdateRenderer } from './pr-update-renderer';

it('renders a noneditable, escaped PR update card and hides its receipt marker', () => {
  const html = renderToStaticMarkup(
    createElement(PRUpdateRenderer, {
      queued: true,
      text: '<!-- factory-factory-pr-event:delivery -->\n<script>untrusted()</script>',
    })
  );
  expect(html).toContain('queued for next turn');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('factory-factory-pr-event');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('<script>');
});
