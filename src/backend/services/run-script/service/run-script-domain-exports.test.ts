import { describe, expect, it } from 'vitest';
import * as runScriptExports from './index';
import {
  createRunScriptService,
  FactoryConfigService,
  RunScriptService,
  RunScriptStateMachineError,
  runScriptConfigPersistenceService,
  runScriptStateMachine,
  startupScriptService,
} from './index';

describe('Run script domain barrel exports', () => {
  it('exports runScriptService factory', () => {
    const service = createRunScriptService();
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(RunScriptService);
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

  it('exports run-script configuration services', () => {
    expect(typeof FactoryConfigService.readConfig).toBe('function');
    expect(runScriptConfigPersistenceService).toBeDefined();
  });

  it('keeps internal run-script infrastructure out of the public barrel', () => {
    expect(runScriptExports).not.toHaveProperty('PortAllocationService');
    expect(runScriptExports).not.toHaveProperty('RunScriptProxyService');
    expect(runScriptExports).not.toHaveProperty('runScriptProxyService');
  });
});
