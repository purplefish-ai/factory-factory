// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitStatusBanner } from './workspace-init-status-banner';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InitStatusBanner setup retry', () => {
  it('calls Retry setup and shows a disabled spinner while retrying', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onRetry = vi.fn();
    const props = {
      banner: {
        kind: 'error' as const,
        message: 'Setup failed',
        showRetry: true,
        showPlay: false,
        showDismiss: false,
      },
      retryPending: false,
      onRetry,
      onPlay: vi.fn(),
    };
    try {
      act(() => root.render(<InitStatusBanner {...props} />));
      const button = container.querySelector('button');
      expect(button?.textContent).toContain('Retry setup');
      act(() => button?.click());
      expect(onRetry).toHaveBeenCalledOnce();
      act(() => root.render(<InitStatusBanner {...props} retryPending />));
      expect(button?.disabled).toBe(true);
      expect(button?.textContent).toContain('Retrying...');
      expect(button?.querySelector('.animate-spin')).not.toBeNull();
      act(() => button?.click());
      expect(onRetry).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });
});
