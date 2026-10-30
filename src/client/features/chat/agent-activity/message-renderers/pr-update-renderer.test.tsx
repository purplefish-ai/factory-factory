import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PRUpdateRenderer } from './pr-update-renderer';

it('shows only a status line while a PR update is waiting for dispatch', () => {
  const html = renderToStaticMarkup(
    createElement(PRUpdateRenderer, {
      queued: true,
      text: 'PR update queued for the next turn',
    })
  );
  expect(html).toContain('PR update · queued for next turn');
  expect(html).not.toContain('<details');
  expect(html).not.toContain('PR update queued for the next turn');
});

it('renders a noneditable, escaped PR update card and hides its receipt marker', () => {
  const html = renderToStaticMarkup(
    createElement(PRUpdateRenderer, {
      text: '<!-- factory-factory-pr-event:delivery -->\n<script>untrusted()</script>',
    })
  );
  expect(html).toContain('<summary');
  expect(html).not.toContain('View update');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('factory-factory-pr-event');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('<script>');
});

it.each(['failed'] as const)('renders an explicit %s delivery state', (prDeliveryState) => {
  const html = renderToStaticMarkup(
    createElement(PRUpdateRenderer, {
      text: '<!-- factory-factory-pr-event:test -->\nReview feedback received',
      deliveryState: prDeliveryState,
    })
  );
  expect(html).toContain(prDeliveryState);
  expect(html).not.toContain('queued for next turn');
  expect(html).not.toContain('factory-factory-pr-event');
});

it('hides cancelled updates, including their details and cancellation errors', () => {
  const html = renderToStaticMarkup(
    createElement(PRUpdateRenderer, {
      text: '<!-- factory-factory-pr-event:test -->\nReview feedback received',
      deliveryState: 'cancelled',
      error: 'Session stopped before dispatch',
    })
  );
  expect(html).toBe('');
});
