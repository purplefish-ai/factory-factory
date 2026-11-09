import { createElement } from 'react';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';

export async function chooseAgentCreation(
  scope: ParentNode,
  kind: 'scheduled' | 'event' = 'scheduled'
) {
  const trigger = [...scope.querySelectorAll('button')].find(
    (button) => button.textContent === 'Create automation'
  );
  if (!trigger) {
    throw new Error('Missing Create automation menu');
  }
  actFlushSync(() =>
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) =>
      element.textContent ===
      (kind === 'scheduled' ? 'Scheduled automation' : 'Event-triggered automation')
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

export function fillAgentDraft(scope: ParentNode, name: string, instructions: string) {
  actFlushSync(() => {
    for (const [selector, value, prototype] of [
      ['input[name="name"]', name, HTMLInputElement.prototype],
      ['textarea', instructions, HTMLTextAreaElement.prototype],
    ] as const) {
      const field = scope.querySelector(selector);
      if (!field) {
        throw new Error(`Missing draft field: ${selector}`);
      }
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
