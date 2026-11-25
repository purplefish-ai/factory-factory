// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionlessSetupFailure } from './sessionless-setup-failure';
import { InitStatusBanner } from './workspace-init-status-banner';
import { ScriptFailedBanner } from './workspace-overlays';
const retry = vi.fn();
vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({ retry, retryInit: { isPending: false } }),
}));
const blocked = {
  status: 'BLOCKED' as const,
  reason: 'INITIAL_PENDING' as const,
  explanation: 'The event initial task has not been sent yet.',
};
it.each(['warning', 'sessionless', 'chat'] as const)(
  'keeps %s retry unavailable until owner availability is known and allowed',
  (surface) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const banner = {
      kind: 'error' as const,
      message: 'Setup failed',
      showRetry: true,
      showPlay: false,
      showDismiss: false,
    };
    const render = (retryAvailability?: typeof blocked | { status: 'AVAILABLE' }) => {
      flushSync(() =>
        root.render(
          surface === 'warning'
            ? createElement(ScriptFailedBanner, {
                workspaceId: 'workspace',
                initErrorMessage: 'Setup failed',
                initOutput: 'Output retained',
                hasStartupScript: true,
                retryAvailability,
              })
            : surface === 'sessionless'
              ? createElement(SessionlessSetupFailure, {
                  workspaceId: 'workspace',
                  banner,
                  errorMessage: 'Setup failed',
                  retryAvailability,
                })
              : createElement(InitStatusBanner, {
                  banner,
                  retryPending: false,
                  onRetry: retry,
                  onPlay: () => undefined,
                  retryAvailability,
                })
        )
      );
    };
    try {
      render();
      expect(
        Array.from(container.querySelectorAll('button')).find((node) =>
          /Retry/.test(node.textContent ?? '')
        )?.disabled
      ).toBe(true);
      render(blocked);
      const button = Array.from(container.querySelectorAll('button')).find((node) =>
        /Retry/.test(node.textContent ?? '')
      );
      expect(button?.disabled).toBe(true);
      expect(container.textContent).toContain(blocked.explanation);
      render({ status: 'AVAILABLE' });
      expect(
        Array.from(container.querySelectorAll('button')).find((node) =>
          /Retry/.test(node.textContent ?? '')
        )?.disabled
      ).toBe(false);
    } finally {
      root.unmount();
    }
  }
);
it('offers no sessionless retry when the init policy hides it after an incomplete archive', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const message = 'Archive incomplete: remove failed. Archive again to finish.';
  try {
    flushSync(() =>
      root.render(
        createElement(SessionlessSetupFailure, {
          workspaceId: 'workspace',
          banner: { kind: 'error', message, showRetry: false, showPlay: false, showDismiss: false },
          errorMessage: message,
          retryAvailability: {
            status: 'BLOCKED',
            reason: 'ARCHIVE_INCOMPLETE',
            explanation: 'The archive did not finish.',
          },
        })
      )
    );
    expect(container.textContent).toContain(message);
    expect(
      Array.from(container.querySelectorAll('button')).some((node) =>
        /Retry/.test(node.textContent ?? '')
      )
    ).toBe(false);
  } finally {
    root.unmount();
  }
});
