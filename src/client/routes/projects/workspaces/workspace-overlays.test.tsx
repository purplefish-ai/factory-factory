// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptFailedBanner } from './workspace-overlays';

vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({
    retry: vi.fn(),
    retryInit: {
      isPending: false,
    },
  }),
}));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ScriptFailedBanner', () => {
  it('uses wrapping layout classes for long init error messages', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(ScriptFailedBanner, {
          workspaceId: 'workspace-1',
          initErrorMessage:
            'Command failed: pnpm install --filter this-is-an-intentionally-long-package-name --reporter append-only because the generated lockfile checksum did not match the expected workspace state after bootstrap',
          initOutput: 'npm ERR! code ERESOLVE',
          hasStartupScript: true,
        })
      );
    });

    // A danger strip callout: its message column wraps long text and its
    // actions move under the message when the banner is narrow.
    const banner = container.querySelector('[data-slot="status-callout"]');
    expect(banner?.getAttribute('data-status-tone')).toBe('danger');
    expect(banner?.className).toContain('flex-wrap');

    const message = Array.from(container.querySelectorAll('p')).find((node) =>
      node.textContent?.startsWith('Init script failed:')
    );
    const messageColumn = message?.closest('.break-words');
    expect(messageColumn?.className).toContain('min-w-0');
    expect(banner?.contains(messageColumn ?? null)).toBe(true);

    const actionRow = Array.from(banner?.children ?? []).find((child) =>
      child.textContent?.includes('Show output')
    );
    expect(actionRow?.className).toContain('flex-wrap');
    expect(actionRow?.textContent).toContain('Show output');
    expect(actionRow?.textContent).toContain('Retry');

    root.unmount();
  });
});
