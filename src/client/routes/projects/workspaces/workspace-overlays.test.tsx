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

    const layoutRow = container.querySelector('.border-b > div');
    expect(layoutRow?.className).toContain('flex-col');
    expect(layoutRow?.className).toContain('sm:flex-row');

    const message = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.startsWith('Init script failed:')
    );
    expect(message?.className).toContain('break-words');
    expect(message?.className).toContain('whitespace-normal');

    const actionRow = Array.from(container.querySelectorAll('div')).find((node) => {
      const className = node.className;
      return typeof className === 'string' && className.includes('flex-wrap');
    });
    expect(actionRow?.className).toContain('self-start');

    root.unmount();
  });
});
