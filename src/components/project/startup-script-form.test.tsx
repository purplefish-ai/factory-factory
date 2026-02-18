// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupScriptForm } from './startup-script-form';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('StartupScriptForm', () => {
  it('applies mobile-safe wrapping and width constraints', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(StartupScriptForm, {
          scriptType: 'command',
          onScriptTypeChange: vi.fn(),
          startupScript:
            'pnpm dlx turbo run build --filter this-is-an-intentionally-long-script-for-mobile-layout-checks',
          onStartupScriptChange: vi.fn(),
          idPrefix: 'startup-test',
          hideHeader: false,
        })
      );
    });

    const rootNode = container.firstElementChild as HTMLElement | null;
    expect(rootNode).not.toBeNull();
    expect(rootNode?.className).toContain('min-w-0');

    const description = Array.from(container.querySelectorAll('p')).find((node) =>
      node.textContent?.includes('Command or script to run when initializing new workspaces.')
    );
    expect(description?.className).toContain('break-words');

    const radioGroup = container.querySelector('[role="radiogroup"]');
    expect(radioGroup?.className).toContain('grid-cols-1');
    expect(radioGroup?.className).toContain('sm:grid-cols-2');

    const commandLabel = container.querySelector('label[for="startup-test-command"]');
    expect(commandLabel?.className).toContain('break-words');

    const input = container.querySelector('input');
    expect(input?.className).toContain('min-w-0');
    expect(input?.className).toContain('w-full');

    root.unmount();
  });
});
