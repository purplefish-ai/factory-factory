// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { AgentForm } from './agent-form';
import { AgentRunHistory } from './agent-run-history';
import type { AgentRun } from './types';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  actFlushSync(() => root.unmount());
  container.remove();
});
function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: 'run',
    periodicTaskId: 'agent',
    workspaceId: null,
    status: 'RUNNING',
    prUrl: null,
    prNumber: null,
    errorMessage: null,
    startedAt: new Date('2026-10-29T12:00:00Z'),
    completedAt: null,
    ...overrides,
  };
}
function renderHistory(runs: AgentRun[] | undefined, extra = {}) {
  actFlushSync(() =>
    root.render(
      <MemoryRouter>
        <AgentRunHistory runs={runs} projectSlug="owner-project" {...extra} />
      </MemoryRouter>
    )
  );
}

describe('AgentRunHistory', () => {
  it('links every non-null workspace ID using the owning project, including archived workspaces', () => {
    renderHistory([
      run({
        workspaceId: 'archived-workspace',
        status: 'PR_CREATED',
        prUrl: 'https://github.com/example/repo/pull/4',
        prNumber: 4,
      }),
    ]);
    expect(
      container.querySelector('a[href="/projects/owner-project/workspaces/archived-workspace"]')
        ?.textContent
    ).toContain('Open workspace');
    expect(
      container.querySelector('a[href="https://github.com/example/repo/pull/4"]')?.textContent
    ).toContain('#4');
    expect(container.querySelector('a[target="_blank"]')?.textContent).toContain(
      '(opens in new tab)'
    );
    expect(container.textContent).toContain('Up to 50 recent runs');
  });
  it('distinguishes a running workspace not yet created from an unavailable terminal workspace', () => {
    renderHistory([
      run({ id: 'running' }),
      run({ id: 'failed', status: 'FAILED', errorMessage: 'Provider permission denied' }),
      run({ id: 'missing', status: 'PR_CREATED' }),
    ]);
    expect(container.textContent).toContain('No workspace yet');
    expect(container.textContent).toContain('No workspace linked');
    expect(container.textContent).toContain('Workspace unavailable');
    expect(container.textContent).toContain('Provider permission denied');
    expect(container.textContent).not.toContain('deleted');
  });
  it('encodes imported project slugs and workspace IDs in run-history links', () => {
    renderHistory([run({ workspaceId: 'workspace/one space' })], {
      projectSlug: 'owner/project space',
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/projects/owner%2Fproject%20space/workspaces/workspace%2Fone%20space'
    );
  });
  it('does not show a failed or loading request as an empty history and supports retry', () => {
    renderHistory(undefined, { isLoading: true });
    expect(container.textContent).toContain('Loading run history');
    expect(container.textContent).not.toContain('No runs yet');
    const retry = vi.fn();
    renderHistory(undefined, { error: 'Connection lost', onRetry: retry });
    expect(container.textContent).toContain('Connection lost');
    actFlushSync(() => container.querySelector('button')?.click());
    expect(retry).toHaveBeenCalledOnce();
    renderHistory([]);
    expect(container.textContent).toContain('No runs yet');
  });
});

describe('AgentForm', () => {
  it('explains that the first run starts shortly after creation', () => {
    actFlushSync(() => root.render(<AgentForm onSave={vi.fn()} onCancel={vi.fn()} />));
    expect(container.textContent).toContain(
      'The first run starts shortly after creation, then follows this schedule.'
    );
  });

  it('hides clock-time guidance when the selected cadence cannot save a clock time', () => {
    actFlushSync(() =>
      root.render(
        <AgentForm
          initialValues={{
            name: 'Interval',
            prompt: 'Check',
            cadence: 'EVERY_MINUTE',
            scheduledTime: '09:30',
            timezone: 'Asia/Tokyo',
          }}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    );
    expect(container.querySelector('input[type="time"]')).toBeNull();
    expect(container.textContent).not.toContain('Clock times');
  });

  it('trims input, preserves the draft on failure, and prevents repeated pending submissions', async () => {
    let rejectSave: (error: Error) => void = vi.fn();
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        })
    );
    actFlushSync(() =>
      root.render(
        <AgentForm
          initialValues={{
            name: '  Review code  ',
            prompt: '  Find regressions  ',
            cadence: 'DAILY',
            scheduledTime: '09:30',
            timezone: 'Asia/Tokyo',
          }}
          onSave={onSave}
          onCancel={vi.fn()}
        />
      )
    );
    const form = container.querySelector('form');
    actFlushSync(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSave).toHaveBeenCalledWith({
      name: 'Review code',
      prompt: 'Find regressions',
      cadence: 'DAILY',
      scheduledTime: '09:30',
      timezone: 'Asia/Tokyo',
    });
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    actFlushSync(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => {
      rejectSave(new Error('Save failed'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Save failed');
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      '  Review code  '
    );
  });
  it.each(['name', 'instructions'])(
    'clears stale required validation when %s is edited',
    (fieldName) => {
      actFlushSync(() =>
        root.render(
          <AgentForm
            initialValues={{
              name: ' ',
              prompt: ' ',
              cadence: 'DAILY',
              scheduledTime: null,
              timezone: null,
            }}
            onSave={vi.fn()}
            onCancel={vi.fn()}
          />
        )
      );
      actFlushSync(() =>
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      );
      expect(container.textContent).toContain('Name and instructions are required');
      const field = container.querySelector(`[name="${fieldName}"]`);
      const prototype =
        fieldName === 'name' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      actFlushSync(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, 'Valid text');
        field?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
  );
  it('rejects whitespace-only required fields', () => {
    const onSave = vi.fn();
    actFlushSync(() =>
      root.render(
        <AgentForm
          initialValues={{
            name: '  ',
            prompt: '  ',
            cadence: 'DAILY',
            scheduledTime: null,
            timezone: null,
          }}
          onSave={onSave}
          onCancel={vi.fn()}
        />
      )
    );
    actFlushSync(() => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Name and instructions are required');
  });
});
