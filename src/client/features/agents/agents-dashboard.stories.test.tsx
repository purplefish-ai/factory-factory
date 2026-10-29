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
    render('edit');
    expect(container.querySelector('h2')?.textContent).toBe('Edit Agent');
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Review recent changes'
    );
    render('loading');
    expect(container.textContent).toContain('Loading agent');
    expect(container.querySelector('form')).toBeNull();
    render('populated');
    expect(container.querySelector('h2')?.textContent).toBe('Review recent changes');
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
  }
});
