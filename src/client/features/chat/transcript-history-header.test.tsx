// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptHistoryHeader } from './transcript-history-header';
import type { TranscriptHistoryControls } from './use-transcript-history';

let host: HTMLDivElement;
let root: Root;
const loadOlder = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
});

function render(status: TranscriptHistoryControls['status']) {
  flushSync(() => root.render(<TranscriptHistoryHeader history={{ status, loadOlder }} />));
}

it('keeps a fast history check invisible throughout loading and completion', () => {
  render('idle');
  render('loading');
  expect(host.querySelector('[role="status"]')).toBeNull();
  flushSync(() => {
    vi.advanceTimersByTime(100);
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  flushSync(() => {
    vi.advanceTimersByTime(149);
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  render('complete');
  flushSync(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(host.textContent).toBe('');
});

it('shows feedback for a slow request and hides it as soon as the request finishes', () => {
  render('loading');
  flushSync(() => {
    vi.advanceTimersByTime(249);
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  flushSync(() => {
    vi.advanceTimersByTime(1);
  });
  expect(host.textContent).toContain('Loading earlier messages');
  render('idle');
  expect(host.textContent).toBe('');
  render('loading');
  expect(host.textContent).toBe('');
});

it('shows errors immediately and delays the indicator again on retry', () => {
  render('loading');
  render('error');
  expect(host.textContent).toContain('Could not load earlier messages.');
  flushSync(() => host.querySelector('button')?.click());
  expect(loadOlder).toHaveBeenCalledOnce();
  render('loading');
  expect(host.textContent).toBe('');
  flushSync(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(host.textContent).toContain('Loading earlier messages');
});
