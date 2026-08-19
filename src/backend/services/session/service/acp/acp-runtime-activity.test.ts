import { describe, expect, it } from 'vitest';
import { AcpRuntimeActivity } from './acp-runtime-activity';

describe('AcpRuntimeActivity', () => {
  it('keeps an active task working between prompts until the task stops', () => {
    const activity = new AcpRuntimeActivity();
    activity.recordPurpose('session-1', 'active');

    expect(activity.isWorking('session-1', false)).toBe(false);

    activity.recordEvent('session-1', { type: 'acp_task_status_changed', active: true });
    expect(activity.isWorking('session-1', false)).toBe(true);

    activity.recordEvent('session-1', { type: 'acp_task_status_changed', active: false });
    expect(activity.isWorking('session-1', false)).toBe(false);
  });

  it('never treats browse-only sessions as working', () => {
    const activity = new AcpRuntimeActivity();
    activity.recordPurpose('session-1', 'browse');
    activity.recordEvent('session-1', { type: 'acp_task_status_changed', active: true });

    expect(activity.isWorking('session-1', true)).toBe(false);
  });

  it('restores active task state when a browse-only session is promoted', () => {
    const activity = new AcpRuntimeActivity();
    activity.recordPurpose('session-1', 'browse');
    activity.recordEvent('session-1', { type: 'acp_task_status_changed', active: true });
    activity.recordPurpose('session-1', 'browse');

    activity.promote('session-1');

    expect(activity.isWorking('session-1', false)).toBe(true);
  });

  it('clears task activity with the runtime lifecycle', () => {
    const activity = new AcpRuntimeActivity();
    activity.recordEvent('session-1', { type: 'acp_task_status_changed', active: true });

    activity.clear('session-1');

    expect(activity.isWorking('session-1', false)).toBe(false);
  });
});
