// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@/lib/chat-protocol';
import { PermissionPrompt } from './permission-prompt';

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (
    (buttons.find((button) => button.textContent?.trim() === text) as HTMLButtonElement) ?? null
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PermissionPrompt', () => {
  it('shows plan content for ExitPlanMode even when acpOptions exist', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onApprove = vi.fn();

    const permission: PermissionRequest = {
      requestId: 'req-plan-1',
      toolName: 'ExitPlanMode',
      toolInput: {
        plan: '# Proposed Plan\n\n1. Add the mode mapping',
      },
      timestamp: '2026-02-16T00:00:00.000Z',
      planContent: '# Proposed Plan\n\n1. Add the mode mapping',
      acpOptions: [
        { optionId: 'default', name: 'Approve and switch to Default', kind: 'allow_once' },
        { optionId: 'plan', name: 'Keep planning', kind: 'reject_once' },
      ],
    };

    flushSync(() => {
      root.render(createElement(PermissionPrompt, { permission, onApprove }));
    });

    expect(container.textContent).toContain('Review Plan');
    expect(container.textContent).toContain('Proposed Plan');
    expect(container.textContent).toContain('Approve and switch to Default');
    expect(container.textContent).toContain('Keep planning');

    const approveButton = findButtonByText(container, 'Approve and switch to Default');
    expect(approveButton).not.toBeNull();
    approveButton?.click();

    expect(onApprove).toHaveBeenCalledWith('req-plan-1', true, 'default');

    root.unmount();
  });
});
