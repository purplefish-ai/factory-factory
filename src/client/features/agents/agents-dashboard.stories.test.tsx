// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import meta from './agents-dashboard.stories';

it('resets the visual session and form when Storybook Controls change the state argument', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const Dashboard = meta.component;
  const render = (state: 'create' | 'edit' | 'loading' | 'populated') =>
    actFlushSync(() =>
      root.render(
        <MemoryRouter>
          <Dashboard state={state} />
        </MemoryRouter>
      )
    );
  try {
    render('create');
    expect(container.querySelector('h2')?.textContent).toBe('Create Agent');
    expect(container.querySelector('main')?.textContent).not.toContain('Factory Factory');
    const draftName = container.querySelector<HTMLInputElement>('input[name="name"]');
    const draftInstructions = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!(draftName && draftInstructions)) {
      throw new Error('Expected the Create story form fields');
    }
    actFlushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        draftName,
        'Unsaved creation name'
      );
      draftName.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        draftInstructions,
        'Unsaved creation instructions'
      );
      draftInstructions.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(draftName.value).toBe('Unsaved creation name');
    expect(draftInstructions.value).toBe('Unsaved creation instructions');
    render('edit');
    expect(container.querySelector('h2')?.textContent).toBe('Edit Agent');
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Review recent changes'
    );
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain(
      'Review the changes merged in the last day.'
    );
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toContain(
      'Unsaved creation instructions'
    );
    render('loading');
    expect(container.textContent).toContain('Loading agent');
    expect(container.querySelector('form')).toBeNull();
    render('populated');
    expect(container.querySelector('h2')?.textContent).toBe('Review recent changes');
    expect(container.querySelector('main')?.textContent).not.toContain('Factory Factory');
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
  }
});
