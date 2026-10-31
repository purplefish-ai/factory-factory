// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { useWorkspaceCreationSubmission } from './use-workspace-creation-submission';

const storage = vi.hoisted(() => ({
  drafts: new Map<string, { revision: string } | null>(),
  clear: vi.fn<(projectId: string, revision: string) => Promise<boolean>>(),
}));
vi.mock('./workspace-creation-draft-storage', () => ({
  getWorkspaceCreationDraftSnapshot: (projectId: string) => ({
    draft: storage.drafts.get(projectId) ?? null,
  }),
  clearWorkspaceCreationDraft: storage.clear,
}));
let unmount: (() => void)[] = [];
function SubmissionHarness({
  id,
  onValue,
}: {
  id: string;
  onValue: (value: ReturnType<typeof useWorkspaceCreationSubmission>) => void;
}) {
  onValue(useWorkspaceCreationSubmission(id));
  return null;
}
function mount(projectId: string) {
  let latest: ReturnType<typeof useWorkspaceCreationSubmission>;
  const root = createRoot(document.createElement('div'));
  const onValue = (value: ReturnType<typeof useWorkspaceCreationSubmission>) => {
    latest = value;
  };
  actFlushSync(() => root.render(<SubmissionHarness id={projectId} onValue={onValue} />));
  const stop = () => actFlushSync(() => root.unmount());
  unmount.push(stop);
  return {
    get current() {
      return latest!;
    },
    stop,
    switchProject: (id: string) =>
      actFlushSync(() => root.render(<SubmissionHarness id={id} onValue={onValue} />)),
  };
}
beforeEach(() => {
  storage.drafts.clear();
  storage.clear.mockImplementation((projectId, revision) => {
    if (storage.drafts.get(projectId)?.revision !== revision) {
      return Promise.resolve(false);
    }
    storage.drafts.set(projectId, null);
    return Promise.resolve(true);
  });
});
afterEach(() => {
  for (const stop of unmount) {
    stop();
  }
  unmount = [];
  vi.clearAllMocks();
});

describe('workspace creation submission lifecycle', () => {
  it('retains pending state across remount and prevents duplicate submissions', () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'submitted' });
    const first = mount(id);
    let submission: ReturnType<typeof first.current.begin>;
    actFlushSync(() => {
      submission = first.current.begin();
    });
    first.stop();
    unmount.shift();
    const second = mount(id);
    expect(second.current.isPending).toBe(true);
    actFlushSync(() => {
      expect(second.current.begin()).toBeNull();
    });
    actFlushSync(() => second.current.fail(submission!, 'Could not create worktree'));
    expect(second.current.isPending).toBe(false);
    expect(second.current.error).toBe('Could not create worktree');
    expect(storage.drafts.get(id)?.revision).toBe('submitted');
  });

  it('clears a successfully submitted draft and allows its mounted composer to close', async () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'submitted' });
    const form = mount(id);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    let close = false;
    await act(async () => {
      close = await form.current.succeed(submission!);
    });
    expect(close).toBe(true);
    expect(storage.drafts.get(id)).toBeNull();
    expect(form.current.isPending).toBe(false);
  });

  it('retains a newer draft and never closes it on a late success', async () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'old' });
    const form = mount(id);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    storage.drafts.set(id, { revision: 'new' });
    let close = true;
    await act(async () => {
      close = await form.current.succeed(submission!);
    });
    expect(close).toBe(false);
    expect(storage.drafts.get(id)?.revision).toBe('new');
  });

  it('does not close a newer draft written while storage clearing is pending', async () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'old' });
    const form = mount(id);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    let release: (cleared: boolean) => void = () => undefined;
    storage.clear.mockImplementationOnce(() => {
      storage.drafts.set(id, null);
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    let completion: Promise<boolean>;
    actFlushSync(() => {
      completion = form.current.succeed(submission!);
    });
    storage.drafts.set(id, { revision: 'new' });
    let close = true;
    await act(async () => {
      release(true);
      close = await completion!;
    });
    expect(close).toBe(false);
  });

  it('cleans up the original project after navigation without closing the new composer', async () => {
    const original = crypto.randomUUID(),
      next = crypto.randomUUID();
    storage.drafts.set(original, { revision: 'original' });
    storage.drafts.set(next, { revision: 'next' });
    const form = mount(original);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    const finish = form.current.succeed;
    form.switchProject(next);
    let close = true;
    await act(async () => {
      close = await finish(submission!);
    });
    expect(close).toBe(false);
    expect(storage.drafts.get(original)).toBeNull();
    expect(storage.drafts.get(next)?.revision).toBe('next');
  });

  it('clears after unmount without firing the obsolete composer close callback', async () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'submitted' });
    const form = mount(id);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    const finish = form.current.succeed;
    form.stop();
    unmount.shift();
    expect(await finish(submission!)).toBe(false);
    expect(storage.drafts.get(id)).toBeNull();
  });

  it('surfaces storage cleanup failure and releases pending state', async () => {
    const id = crypto.randomUUID();
    storage.drafts.set(id, { revision: 'submitted' });
    const form = mount(id);
    let submission: ReturnType<typeof form.current.begin>;
    actFlushSync(() => {
      submission = form.current.begin();
    });
    storage.clear.mockRejectedValueOnce(new Error('storage unavailable'));
    let close = true;
    await act(async () => {
      close = await form.current.succeed(submission!);
    });
    expect(close).toBe(false);
    expect(form.current.isPending).toBe(false);
    expect(form.current.error).toContain('created');
    expect(form.current.error).toContain('draft');
  });
});
