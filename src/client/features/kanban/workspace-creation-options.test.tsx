// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceCreationOptions } from './workspace-creation-options';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function Preview({
  invalidAccess = false,
  initialAccess = 'workspace-write',
  initialPlan = false,
  planLoading = false,
  planSupported = true,
}: {
  invalidAccess?: boolean;
  initialAccess?: string;
  initialPlan?: boolean;
  planLoading?: boolean;
  planSupported?: boolean;
}) {
  const [account, setAccount] = useState<string>();
  const [plan, setPlan] = useState(initialPlan);
  const [ratchet, setRatchet] = useState(false);
  const [access, setAccess] = useState(invalidAccess ? 'retired-mode' : initialAccess);
  return (
    <TooltipProvider>
      <WorkspaceCreationOptions
        enabled
        disabled={false}
        settingsLoading={false}
        ratchetEnabled={ratchet}
        onRatchetChange={setRatchet}
        onAttach={vi.fn()}
        selection={{
          provider: 'CODEX',
          model: 'sol',
          models: [{ value: 'sol', label: 'GPT-6.1-Sol' }],
          onModelChange: vi.fn(),
          account: {
            accounts: [{ id: 'work', label: 'Work', authenticated: true, enabled: true }],
            value: account,
            onChange: setAccount,
          },
          reasoning: {
            value: 'high',
            options: [{ value: 'high', label: 'High' }],
            loading: false,
            invalid: false,
            onChange: vi.fn(),
            onRetry: vi.fn(),
          },
          accessMode: {
            value: access,
            options: [
              { value: 'workspace-write', label: 'Workspace write' },
              ...(initialAccess === 'workspace-write'
                ? []
                : [{ value: initialAccess, label: 'Full access' }]),
            ],
            loading: false,
            invalid: access === 'retired-mode',
            onChange: setAccess,
          },
          planMode: {
            enabled: plan,
            supported: planSupported,
            loading: planLoading,
            onChange: setPlan,
          },
        }}
      >
        <button type="button">Launch</button>
      </WorkspaceCreationOptions>
    </TooltipProvider>
  );
}

async function mount(invalidAccess = false, initialAccess?: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(<Preview invalidAccess={invalidAccess} initialAccess={initialAccess} />)
  );
  return { container, root };
}

function button(label: string) {
  const element = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}

async function choose(trigger: HTMLButtonElement, label: string) {
  await act(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
  );
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === label
  );
  expect(item, label).toBeDefined();
  await act(() => item?.click());
}

it('keeps model and thinking visible while retaining secondary choices across settings dismissal', async () => {
  const { container, root } = await mount();
  try {
    button('Provider and model: Codex · GPT-6.1-Sol');
    button('Thinking level: High');
    button('Attach files');
    expect(container.querySelector('[aria-label^="Codex account:"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Planning:"]')).toBeNull();
    await act(() => button('Workspace settings').click());
    expect(button('Planning: Off').textContent).toBe('Off');
    await choose(button('Codex account: Auto'), 'Work');
    await act(() => button('Planning: Off').click());
    await act(() => button('Enable PR updates').click());
    await act(() => button('Workspace settings').click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(() => button('Workspace settings').click());
    button('Codex account: Work');
    expect(button('Planning: On').getAttribute('aria-pressed')).toBe('true');
    expect(button('Planning: On').textContent).toBe('On');
    expect(button('Disable PR updates').getAttribute('aria-pressed')).toBe('true');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each([
  'agent-full-access',
  'bypassPermissions',
  'dangerouslySkipPermissions',
  'dangerousSkipPermissions',
])('keeps the %s access warning visible when settings are closed', async (access) => {
  const { container, root } = await mount(false, access);
  try {
    expect(button('Workspace settings').className).toMatch(/text-orange-/);
    expect(button('Workspace settings').getAttribute('aria-description')).toContain(
      'Warning: Full access'
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('waits for Plan support discovery before warning about an enabled unsupported Plan', async () => {
  const { container, root } = await mount();
  try {
    // Remount the preview with Plan already enabled, then resolve its discovery state.
    await act(() =>
      root.render(<Preview key="plan" initialPlan planLoading planSupported={false} />)
    );
    expect(button('Workspace settings').getAttribute('aria-invalid')).not.toBe('true');
    await act(() => root.render(<Preview key="plan" initialPlan planSupported={false} />));
    expect(button('Workspace settings').getAttribute('aria-invalid')).toBe('true');
    await act(() => root.render(<Preview key="plan" initialPlan planSupported />));
    expect(button('Workspace settings').getAttribute('aria-invalid')).not.toBe('true');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('surfaces a hidden invalid access choice on the settings button and allows correcting it', async () => {
  const { container, root } = await mount(true);
  try {
    expect(button('Workspace settings').getAttribute('aria-invalid')).toBe('true');
    await act(() => button('Workspace settings').click());
    await choose(button('Access: retired-mode'), 'Workspace write');
    expect(button('Workspace settings').getAttribute('aria-invalid')).not.toBe('true');
    button('Access: Workspace write');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
