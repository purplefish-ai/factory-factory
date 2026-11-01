import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @vitest-environment jsdom
import { reconcileSessionTargetStops } from '@/client/features/session-controls';
import { SubagentList } from './subagent-list';
import type { SubagentListItem } from './types';

const mocks = vi.hoisted(() => ({ stop: vi.fn().mockResolvedValue(undefined), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { session: { stopTarget: { useMutation: () => ({ mutateAsync: mocks.stop }) } } },
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onSelect = vi.fn();
function item(id: string, control = true): SubagentListItem {
  return {
    id,
    name: id,
    status: 'running',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    latestActivity: null,
    resultPreview: null,
    ...(control ? { stopControl: { runtimeId: 'runtime', controlId: `control-${id}` } } : {}),
  };
}
const rows = [item('selected'), item('sibling'), item('unsupported', false)];
async function render(controlSessionId: string | undefined, subagents = rows) {
  await act(() =>
    root.render(
      <SubagentList
        controlSessionId={controlSessionId}
        controlRuntimeId="runtime"
        state={{ kind: 'ready', subagents }}
        onSelect={onSelect}
      />
    )
  );
}
function stops() {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop subagent"]')];
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.stop.mockClear();
  mocks.error.mockClear();
  onSelect.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  reconcileSessionTargetStops('parent', 'subagent', []);
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('keeps stopping separate from selection and disables only the selected live child', async () => {
  await render('parent');
  expect(stops()).toHaveLength(2);
  expect(container.querySelector('button button')).toBeNull();
  await act(() => stops()[0]!.click());
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'parent',
    target: { kind: 'subagent', id: 'selected', controlId: 'control-selected' },
  });
  expect(onSelect).not.toHaveBeenCalled();
  expect(stops()[0]?.disabled).toBe(true);
  expect(stops()[1]?.disabled).toBe(false);
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
  expect(onSelect).toHaveBeenCalledWith(rows[0]);
});

it('removes controls on completion and on disconnected cached rows', async () => {
  await render('parent');
  await render('parent', [{ ...rows[0]!, status: 'completed' }, rows[1]!, rows[2]!]);
  expect(stops()).toHaveLength(1);
  await render(undefined);
  expect(stops()).toHaveLength(0);
});

it('retains pending child interruption when the Sessions list remounts', async () => {
  await render('parent');
  await act(() => stops()[0]!.click());
  await act(() => root.render(null));
  await render('parent');
  expect(stops()[0]?.disabled).toBe(true);
  await act(() => stops()[0]!.click());
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});

it('cleans pending control on terminal status even if a cached row still carries its old reference', async () => {
  vi.useFakeTimers();
  await render('parent');
  await act(() => stops()[0]!.click());
  await render('parent', [{ ...rows[0]!, status: 'completed' }, rows[1]!, rows[2]!]);
  await act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.error).not.toHaveBeenCalled();
});
