import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedPRDelivery } from '@/shared/pr-monitoring';
import { createPRBackgroundDeliveryPort } from './pr-event-delivery-port';
import type { PRDeliveryPorts } from './pr-monitoring-ports';

const deferBusy = vi.fn();
const settleDelivery = vi.fn();
const pauseWorkspace = vi.fn();
const findAgentSessionById = vi.fn();
const emit = vi.fn();

const port = createPRBackgroundDeliveryPort({
  workspacePRMonitoringService: { deferBusy, settleDelivery, pauseWorkspace },
  sessionDataService: { findAgentSessionById },
  ratchetService: { emit },
} as unknown as PRDeliveryPorts);

function delivery(attempt: number): ClaimedPRDelivery {
  return {
    deliveryId: 'delivery',
    sessionId: 'main',
    bindingRevision: 4,
    eventIds: ['event'],
    text: 'frozen',
    attempt,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  settleDelivery.mockResolvedValue(true);
  pauseWorkspace.mockResolvedValue({ count: 1 });
  findAgentSessionById.mockResolvedValue({ id: 'main', workspaceId: 'w' });
});

describe('PR background delivery failure reasons', () => {
  it('defers a busy failure without spending an attempt, whatever its message', async () => {
    const failure = { reason: 'busy' as const, error: new Error('Reworded: still answering') };
    await expect(port.fail(delivery(3), failure)).resolves.toEqual({ paused: false });
    expect(deferBusy).toHaveBeenCalledWith('delivery');
    expect(settleDelivery).not.toHaveBeenCalled();
    expect(pauseWorkspace).not.toHaveBeenCalled();
  });

  it('pauses a resume failure as RESUME_FAILED on its first attempt', async () => {
    const failure = { reason: 'resume_failed' as const, error: new Error('Chat could not reopen') };
    await expect(port.fail(delivery(1), failure)).resolves.toEqual({ paused: true });
    expect(settleDelivery).toHaveBeenCalledWith(expect.objectContaining({ result: 'retry' }));
    expect(pauseWorkspace).toHaveBeenCalledWith('w', 'RESUME_FAILED', 4);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('ignores message text that mentions the old busy and resume phrases', async () => {
    for (const message of [
      'Required existing conversation could not be restored',
      'Turn in progress: human message queued during preparation',
    ]) {
      await expect(
        port.fail(delivery(1), { reason: 'failed', error: new Error(message) })
      ).resolves.toEqual({ paused: false });
    }
    expect(deferBusy).not.toHaveBeenCalled();
    expect(settleDelivery).toHaveBeenCalledTimes(2);
    expect(pauseWorkspace).not.toHaveBeenCalled();
  });

  it('ignores a failure for a claim that is already settled or stale', async () => {
    settleDelivery.mockResolvedValueOnce(false);
    const failure = { reason: 'resume_failed' as const, error: new Error('late') };
    await expect(port.fail(delivery(3), failure)).resolves.toEqual({ paused: false });
    expect(pauseWorkspace).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('pauses ordinary failures as DELIVERY_FAILED once the retry allowance is spent', async () => {
    await port.fail(delivery(3), { reason: 'failed', error: new Error('transport failure') });
    expect(pauseWorkspace).toHaveBeenCalledWith('w', 'DELIVERY_FAILED', 4);
  });
});
