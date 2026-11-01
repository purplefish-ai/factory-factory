import { describe, expect, it, vi } from 'vitest';
import { sessionRouter } from './session.trpc';

function setup(error?: Error) {
  const stopTarget = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(undefined);
  const ensureSubagentBrowseSession = vi.fn();
  const caller = sessionRouter.createCaller({
    appContext: {
      services: {
        acpRuntimeManager: { stopTarget },
        sessionLifecycleService: { ensureSubagentBrowseSession },
      },
    },
  } as never);
  return { caller, stopTarget, ensureSubagentBrowseSession };
}
const input = {
  sessionId: 'parent',
  target: { kind: 'task' as const, id: 'task', controlId: 'live-control' },
};

describe('session targeted stop mutation', () => {
  it('passes the complete session-scoped identity without restoring a historical runtime', async () => {
    const h = setup();
    await h.caller.stopTarget(input);
    expect(h.stopTarget).toHaveBeenCalledExactlyOnceWith('parent', input.target);
    expect(h.ensureSubagentBrowseSession).not.toHaveBeenCalled();
  });
  it('validates discriminated targets and requires the opaque capability', async () => {
    const h = setup();
    await expect(
      h.caller.stopTarget({ ...input, target: { kind: 'parent', id: 'parent' } } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      h.caller.stopTarget({ ...input, target: { kind: 'task', id: 'task' } } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.stopTarget).not.toHaveBeenCalled();
  });
  it('maps a stale capability failure to a retryable precondition error', async () => {
    const h = setup(
      Object.assign(new Error('This item can no longer be stopped.'), {
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
      })
    );
    await expect(h.caller.stopTarget(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This item can no longer be stopped.',
    });
  });
});
