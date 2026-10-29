// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { SessionTabBar } from './session-tab-bar';

it('shows legacy agent identity in quick chat while preserving ordinary session names', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  const sessions = [
    {
      id: 'agent',
      name: 'Periodic task',
      workflow: 'periodic-task',
      status: 'RUNNING' as const,
      createdAt: new Date(0),
    },
    { id: 'ordinary', name: 'Periodic task', status: 'IDLE' as const, createdAt: new Date(1) },
  ];
  try {
    actFlushSync(() =>
      root.render(
        <SessionTabBar
          sessions={sessions}
          currentSessionId="agent"
          onSelectSession={() => undefined}
          onCreateSession={() => undefined}
          onCloseSession={() => undefined}
        />
      )
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs[0]?.textContent).toBe('Agent');
    expect(
      tabs[0]?.querySelector('[aria-label="Agent: RUNNING"]')?.classList.contains('text-brand')
    ).toBe(true);
    expect(tabs[1]?.textContent).toBe('Periodic task');
    expect(tabs[1]?.querySelector('[aria-label^="Agent:"]')).toBeNull();
  } finally {
    actFlushSync(() => root.unmount());
  }
});
