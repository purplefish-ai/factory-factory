// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { AttachmentPreview } from './attachment-preview';

const roots: Root[] = [];
const ID = 'f'.repeat(64);
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

afterEach(() => {
  flushSync(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
});

function render(attachments: MessageAttachment[]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(createElement(AttachmentPreview, { attachments, readOnly: true })));
  return container;
}

const referenced: MessageAttachment = {
  id: 'from-another-device',
  name: 'shot.png',
  type: 'image/png',
  size: 2048,
  data: '',
  contentType: 'image',
  ref: { id: ID, size: 2048, width: 640, height: 480 },
};

describe('AttachmentPreview', () => {
  it('loads a referenced image lazily from its immutable URL', () => {
    const img = render([referenced]).querySelector('img');
    expect(img?.getAttribute('src')).toBe(`/api/chat-images/${ID}`);
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
  });

  it('keeps showing inline images inline', () => {
    const img = render([{ ...referenced, data: PNG, ref: undefined }]).querySelector('img');
    expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`);
  });

  it('shows a failure state when the image cannot load, and in the viewer', () => {
    const container = render([referenced]);
    flushSync(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[aria-label="Image unavailable"]')).not.toBeNull();

    flushSync(() => container.querySelector('button')?.click());
    const dialog = document.querySelector('[role="dialog"]');
    const full = dialog?.querySelector('img');
    expect(full?.getAttribute('src')).toBe(`/api/chat-images/${ID}`);
    flushSync(() => full?.dispatchEvent(new Event('error')));
    expect(dialog?.textContent).toContain('Image unavailable');
  });
});
