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

    const renderedMarkdown = container.querySelector('.prose');
    expect(renderedMarkdown?.className).toContain('overflow-hidden');

    const rawToggleButton = findButtonByText(container, 'Raw');
    expect(rawToggleButton).not.toBeNull();
    flushSync(() => {
      rawToggleButton?.click();
    });
    const rawPlanContent = container.querySelector('pre');
    expect(rawPlanContent?.className).toContain('break-words');

    const approveButton = findButtonByText(container, 'Approve and switch to Default');
    expect(approveButton).not.toBeNull();
    approveButton?.click();

    expect(onApprove).toHaveBeenCalledWith('req-plan-1', true, 'default');

    root.unmount();
  });

  it('uses wrapping button styles for long ACP option labels', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onApprove = vi.fn();

    const permission: PermissionRequest = {
      requestId: 'req-acp-1',
      toolName: 'Bash',
      toolInput: {
        command: 'pnpm test',
      },
      timestamp: '2026-02-16T00:00:00.000Z',
      acpOptions: [
        {
          optionId: 'allow_always',
          name: 'Allow always for this command pattern and working directory scope',
          kind: 'allow_always',
        },
        { optionId: 'reject_once', name: 'Deny once and continue planning', kind: 'reject_once' },
      ],
    };

    flushSync(() => {
      root.render(createElement(PermissionPrompt, { permission, onApprove }));
    });

    const longLabelButton = findButtonByText(
      container,
      'Allow always for this command pattern and working directory scope'
    );
    expect(longLabelButton).not.toBeNull();
    expect(longLabelButton?.className).toContain('whitespace-normal');
    expect(longLabelButton?.className).toContain('max-w-full');
    const promptLayout = container.querySelector('[role="alertdialog"] > div');
    expect(promptLayout?.className).toContain('flex-col');

    root.unmount();
  });
});
