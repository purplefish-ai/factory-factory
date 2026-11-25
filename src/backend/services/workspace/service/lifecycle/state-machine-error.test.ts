import { describe, expect, it } from 'vitest';
import { WorkspaceStateMachineError } from './state-machine.service';

describe('WorkspaceStateMachineError', () => {
  it('should include workspaceId, fromStatus, and toStatus', () => {
    const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY');

    expect(error.workspaceId).toBe('ws-1');
    expect(error.fromStatus).toBe('NEW');
    expect(error.toStatus).toBe('READY');
    expect(error.name).toBe('WorkspaceStateMachineError');
  });

  it('should have default message', () => {
    const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY');

    expect(error.message).toBe('Invalid workspace state transition: NEW → READY (workspace: ws-1)');
  });

  it('should accept custom message', () => {
    const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY', 'Custom error');

    expect(error.message).toBe('Custom error');
  });
});
