// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PRRecipientPicker } from './pr-recipient-picker';

it('requires explicit selection and offers a recovery when no ordinary conversation exists', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  flushSync(() =>
    root.render(
      createElement(PRRecipientPicker, {
        candidates: [],
        pending: false,
        onSelect,
        onCancel: vi.fn(),
      })
    )
  );
  expect(document.body.textContent).toContain('Create a conversation in this workspace');
  const enable = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Enable PR updates'
  );
  expect(enable?.disabled).toBe(true);
  enable?.click();
  expect(onSelect).not.toHaveBeenCalled();
  root.unmount();
  container.remove();
});
