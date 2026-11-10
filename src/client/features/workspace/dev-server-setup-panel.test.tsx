// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitProbe } from '@/test-utils/commit-probe';
import { DevServerSetupPanel } from './dev-server-setup-panel';

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? createElement('div', null, children) : null,
  SheetContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  SheetFooter: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

const runValue = () => document.querySelector<HTMLInputElement>('#run-command')?.value;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('DevServerSetupPanel', () => {
  it('loads the saved config in the first commit of each opening and keeps edits otherwise', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const committed: Array<string | undefined> = [];
    const render = (open: boolean, run: string) => {
      const before = committed.length;
      act(() =>
        root.render(
          createElement(
            Fragment,
            null,
            createElement(DevServerSetupPanel, {
              open,
              onOpenChange: vi.fn(),
              onSave: vi.fn(),
              // A new object each render, as the run-script button passes it.
              currentConfig: { run },
            }),
            createElement(CommitProbe, { onCommit: () => committed.push(runValue()) })
          )
        )
      );
      return [...new Set(committed.slice(before))];
    };

    expect(render(true, 'pnpm dev')).toEqual(['pnpm dev']);

    const type = (value: string) => {
      const input = document.querySelector<HTMLInputElement>('#run-command');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('pnpm dev --open');
    expect(render(true, 'pnpm dev')).toEqual(['pnpm dev --open']);
    expect(render(true, 'pnpm start')).toEqual(['pnpm start']);

    type('unsaved');
    render(false, 'pnpm start');
    expect(render(true, 'pnpm start')).toEqual(['pnpm start']);
    act(() => root.unmount());
  });
});
