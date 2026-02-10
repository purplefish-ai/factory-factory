import { describe, expect, it } from 'vitest';
import {
  RunScriptService,
  RunScriptStateMachineError,
  runScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './index';

describe('Run script domain barrel exports', () => {
  it('exports runScriptService singleton', () => {
    expect(runScriptService).toBeDefined();
    expect(runScriptService).toBeInstanceOf(RunScriptService);
  });

  it('exports RunScriptService class', () => {
    expect(RunScriptService).toBeDefined();
    expect(typeof RunScriptService).toBe('function');
  });

  it('exports runScriptStateMachine singleton', () => {
    expect(runScriptStateMachine).toBeDefined();
  });

  it('exports RunScriptStateMachineError class', () => {
    expect(RunScriptStateMachineError).toBeDefined();
    expect(typeof RunScriptStateMachineError).toBe('function');
  });

  it('exports startupScriptService singleton', () => {
    expect(startupScriptService).toBeDefined();
  });
});
