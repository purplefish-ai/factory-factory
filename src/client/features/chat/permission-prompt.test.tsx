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
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('PermissionPrompt', () => {
  it('shows URL elicitation target and message before explicit authorization', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onApprove = vi.fn();
    const permission: PermissionRequest = {
      requestId: 'url-1',
      toolName: 'Authorize URL',
      timestamp: '2026-10-18T00:00:00Z',
      toolInput: {
        type: 'UrlElicitation',
        url: 'https://example.com/auth',
        message: 'Connect your account',
      },
      acpOptions: [
        { optionId: 'accept', name: 'Authorize', kind: 'allow_once' },
        { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
      ],
    };
    flushSync(() => root.render(createElement(PermissionPrompt, { permission, onApprove })));
    expect(container.textContent).toContain('Connect your account');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/auth');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(onApprove).not.toHaveBeenCalled();
    findButtonByText(container, 'Authorize')!.click();
    expect(onApprove).toHaveBeenCalledWith('url-1', true, 'accept');
    root.unmount();
  });

  it('shows the message and consent button for an empty elicitation form', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onApprove = vi.fn();
    const permission: PermissionRequest = {
      requestId: 'consent',
      toolName: 'Confirm request',
      timestamp: '2026-10-18T00:00:00Z',
      toolInput: { type: 'FormElicitation', message: 'Confirm this request' },
      acpOptions: [
        { optionId: 'accept', kind: 'allow_once', name: 'Confirm' },
        { optionId: 'decline', kind: 'reject_once', name: 'Decline' },
      ],
    };
    flushSync(() => root.render(createElement(PermissionPrompt, { permission, onApprove })));
    expect(container.textContent).toContain('Confirm this request');
    findButtonByText(container, 'Confirm')!.click();
    expect(onApprove).toHaveBeenCalledWith('consent', true, 'accept');
    root.unmount();
  });

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

    const planPrompt = container.querySelector('[aria-label="Plan approval request"]');
    expect(planPrompt?.className).toContain('min-h-0');
    expect(planPrompt?.className).toContain('overflow-y-auto');

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

  it('focuses the first plan approval action after render', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onApprove = vi.fn();

    const permission: PermissionRequest = {
      requestId: 'req-plan-focus-1',
      toolName: 'ExitPlanMode',
      toolInput: {
        plan: 'Focus the first plan action.',
      },
      timestamp: '2026-05-20T00:00:00.000Z',
      planContent: 'Focus the first plan action.',
      acpOptions: [
        { optionId: 'plan', name: 'Keep planning', kind: 'reject_once' },
        { optionId: 'default', name: 'Approve Plan', kind: 'allow_once' },
      ],
    };

    flushSync(() => {
      root.render(createElement(PermissionPrompt, { permission, onApprove }));
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(document.activeElement).toBe(findButtonByText(container, 'Approve Plan'));

    root.unmount();
  });
});
