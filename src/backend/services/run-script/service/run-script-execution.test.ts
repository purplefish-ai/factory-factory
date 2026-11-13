import { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { RunScriptExecution } from './run-script-execution';

function execution() {
  const release = vi.fn();
  const owner = new RunScriptExecution('ws-1', {
    isCurrent: () => true,
    release,
    appendOutput: vi.fn(),
    appendPostRunOutput: vi.fn(),
  });
  return { owner, release };
}

describe('RunScriptExecution ownership', () => {
  it('revokes permission to spawn as soon as stop is requested', () => {
    const { owner } = execution();
    expect(owner.canSpawn).toBe(true);
    owner.requestStop();
    expect(owner.canSpawn).toBe(false);
  });

  it('rejects attaching a child after the attempt has been stopped', () => {
    const { owner } = execution();
    owner.requestStop();
    expect(() => owner.attachProcess(new ChildProcess())).toThrow('stopped');
  });

  it('keeps process observation separate from stop intent', () => {
    const { owner } = execution();
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 1234 });
    owner.attachProcess(child);
    owner.requestStop();
    expect(owner.process).toBe(child);
    expect(owner.canStartAuxiliary).toBe(false);
    expect(owner.observation.kind).toBe('live');
  });
});
