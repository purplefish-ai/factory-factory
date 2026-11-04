import { createElement } from 'react';
import { actFlushSync } from '@/test-utils/react-act';

export function chooseAgentCreation(scope: ParentNode, kind: 'scheduled' | 'event' = 'scheduled') {
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
}

export function renderEventCreationCancel(onCancel: () => void) {
  return createElement('button', { type: 'button', onClick: onCancel }, 'Cancel');
}
