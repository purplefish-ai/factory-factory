import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @vitest-environment jsdom
import { reconcileSessionTargetStops } from '@/client/features/session-controls';
import { SessionActivityIndicator } from './session-activity-indicator';
import { TranscriptTail } from './transcript-layout';

const mocks = vi.hoisted(() => ({ stop: vi.fn(), error: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { session: { stopTarget: { useMutation: () => ({ mutateAsync: mocks.stop }) } } },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const work = {
  controlRuntimeId: 'runtime',
  promptInFlight: false,
  runningSubagents: 0,
  activeGoals: 0,
  backgroundTasks: [
    {
      id: 'one',
      name: 'One',
      kind: 'shell' as const,
      stopControl: { runtimeId: 'runtime', controlId: 'first' },
    },
    {
      id: 'two',
      name: 'Two',
      kind: 'shell' as const,
      stopControl: { runtimeId: 'runtime', controlId: 'second' },
    },
    { id: 'unsupported', name: 'Unsupported', kind: 'shell' as const },
  ],
};
async function render(connected = true, currentWork = work) {
  await act(() =>
    root.render(
      <SessionActivityIndicator
        work={currentWork}
        controlSessionId={connected ? 'parent' : undefined}
      />
    )
  );
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  if (trigger) {
    await act(() => trigger.click());
  }
}
function buttons() {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop process"]')];
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  reconcileSessionTargetStops('parent', 'task', []);
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('background process stop controls', () => {
  it('shows only live supported controls, targets one row, and stays pending after acknowledgment', async () => {
    await render();
    expect(buttons()).toHaveLength(2);
    await act(() => buttons()[1]!.click());
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'parent',
      target: { kind: 'task', id: 'two', controlId: 'second' },
    });
    expect(buttons()[0]?.disabled).toBe(false);
    expect(buttons()[1]?.disabled).toBe(true);
    expect(buttons()[1]?.querySelector('.animate-spin')).not.toBeNull();
    await render(true, {
      ...work,
      backgroundTasks: work.backgroundTasks.filter((task) => task.id !== 'two'),
    });
    expect(buttons()).toHaveLength(1);
  });
  it('reports request errors and permits retry', async () => {
    mocks.stop.mockRejectedValueOnce(new Error('Provider refused'));
    await render();
    await act(() => buttons()[0]!.click());
    expect(mocks.error).toHaveBeenCalledWith('Provider refused');
    expect(buttons()[0]?.disabled).toBe(false);
    await act(() => buttons()[0]!.click());
    expect(buttons()[0]?.disabled).toBe(true);
  });
  it('bounds confirmation waiting and hides cached controls on disconnect', async () => {
    await render();
    await act(() => buttons()[0]!.click());
    await act(() => vi.advanceTimersByTime(15_000));
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('confirmation'));
    expect(buttons()[0]?.disabled).toBe(false);
    await render(false);
    expect(buttons()).toHaveLength(0);
  });
});

it('ignores a late failure from an expired request after a new retry starts', async () => {
  let fail!: (error: Error) => void;
  mocks.stop.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    })
  );
  await render();
  await act(() => buttons()[0]!.click());
  await act(() => vi.advanceTimersByTime(15_000));
  await act(() => buttons()[0]!.click());
  await act(() => fail(new Error('Old failure')));
  expect(buttons()[0]?.disabled).toBe(true);
  expect(mocks.error).not.toHaveBeenCalledWith('Old failure');
});

it('retains pending state through disclosure collapse and reopen', async () => {
  await render();
  await act(() => buttons()[0]!.click());
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
  await act(() => trigger.click());
  await act(() => trigger.click());
  expect(buttons()[0]?.disabled).toBe(true);
  await act(() => buttons()[0]!.click());
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});

it('preserves late errors and the deadline while the disclosure is closed', async () => {
  let fail!: (error: Error) => void;
  mocks.stop.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    })
  );
  await render();
  await act(() => buttons()[0]!.click());
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
  await act(() => trigger.click());
  await act(() => fail(new Error('Late provider refusal')));
  expect(mocks.error).toHaveBeenCalledWith('Late provider refusal');
  await act(() => trigger.click());
  expect(buttons()[0]?.disabled).toBe(false);
  await act(() => buttons()[0]!.click());
  await act(() => trigger.click());
  await act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('confirmation'));
  await act(() => trigger.click());
  expect(buttons()[0]?.disabled).toBe(false);
});

it('cleans pending controls when live completion removes their row', async () => {
  await render();
  await act(() => buttons()[0]!.click());
  await render(true, {
    ...work,
    backgroundTasks: work.backgroundTasks.filter((task) => task.id !== 'one'),
  });
  await act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.error).not.toHaveBeenCalled();
});

it('cleans pending when the last idle background task completes and TranscriptTail removes its indicator', async () => {
  let fail!: (error: Error) => void;
  mocks.stop.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    })
  );
  const props = {
    messages: [],
    running: false,
    startingSession: false,
    loadingSession: false,
    controlSessionId: 'parent',
  };
  const remaining = { ...work, backgroundTasks: [work.backgroundTasks[0]!] };
  await act(() =>
    root.render(<TranscriptTail props={{ ...props, work: remaining }} hasVisibleMessages={false} />)
  );
  await act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click()
  );
  await act(() => buttons()[0]!.click());
  await act(() =>
    root.render(
      <TranscriptTail
        props={{ ...props, work: { ...remaining, backgroundTasks: [] } }}
        hasVisibleMessages={false}
      />
    )
  );
  expect(buttons()).toHaveLength(0);
  await act(() => fail(new Error('Late request failure after live completion')));
  await act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.error).not.toHaveBeenCalled();
});
