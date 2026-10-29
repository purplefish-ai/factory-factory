import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
// @vitest-environment jsdom
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { PauseCircleIcon } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { within } from 'storybook/test';
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
      tabs[0]?.querySelector('[aria-label="Agent: Running"]')?.classList.contains('text-brand')
    ).toBe(true);
    expect(tabs[1]?.textContent).toBe('Periodic task');
    expect(tabs[1]?.querySelector('[aria-label^="Agent:"]')).toBeNull();
  } finally {
    actFlushSync(() => root.unmount());
  }
});

it.each([
  ['IDLE', 'Idle', CircleIcon],
  ['RUNNING', 'Running', PulseIcon],
  ['PAUSED', 'Paused', PauseCircleIcon],
  ['COMPLETED', 'Completed', CheckCircleIcon],
  ['FAILED', 'Failed', XCircleIcon],
] as const)(
  'shows robot identity alongside the distinct %s quick-chat state marker',
  (status, label, Icon) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    const expected = document.createElement('div');
    expected.innerHTML = renderToStaticMarkup(
      <>
        <RobotIcon />
        <Icon />
      </>
    );
    try {
      actFlushSync(() =>
        root.render(
          <SessionTabBar
            sessions={[
              {
                id: 'agent',
                name: 'Custom agent',
                workflow: 'periodic-task',
                status,
                createdAt: new Date(0),
              },
            ]}
            currentSessionId="agent"
            onSelectSession={() => undefined}
            onCreateSession={() => undefined}
            onCloseSession={() => undefined}
          />
        )
      );
      const identity = within(container).getByRole('img', { name: `Agent: ${label}` });
      const icons = identity.querySelectorAll('svg');
      expect(icons).toHaveLength(2);
      expect(icons[0]?.innerHTML).toBe(expected.querySelectorAll('svg')[0]?.innerHTML);
      expect(icons[1]?.innerHTML).toBe(expected.querySelectorAll('svg')[1]?.innerHTML);
      expect(icons[1]?.classList.contains('animate-pulse')).toBe(status === 'RUNNING');
      expect(container.querySelector('[role="tab"]')?.textContent).toBe('Custom agent');
    } finally {
      actFlushSync(() => root.unmount());
    }
  }
);
