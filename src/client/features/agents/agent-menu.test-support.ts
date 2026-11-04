import { createElement } from 'react';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';

export async function chooseAgentCreation(
  scope: ParentNode,
  kind: 'scheduled' | 'event' = 'scheduled'
) {
  const trigger = [...scope.querySelectorAll('button')].find(
    (button) => button.textContent === 'Create agent'
  );
  if (!trigger) {
    throw new Error('Missing Create agent menu');
  }
  actFlushSync(() =>
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === (kind === 'scheduled' ? 'Scheduled agent' : 'Event agent')
  );
  if (!item) {
    throw new Error(`Missing ${kind} creation choice`);
  }
  actFlushSync(() => item.click());
  await waitForReact(() => {
    if (document.querySelector('[role="menu"]')) {
      throw new Error('Creation menu is still closing');
    }
  });
}

export function renderEventCreationCancel(onCancel: () => void) {
  return createElement('button', { type: 'button', onClick: onCancel }, 'Cancel');
}
