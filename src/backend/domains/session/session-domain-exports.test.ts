import { describe, expect, it } from 'vitest';
import {
  ClaudeProcess,
  ClaudeRuntimeManager,
  ClaudeSessionProviderAdapter,
  chatConnectionService,
  chatEventForwarderService,
  chatMessageHandlerService,
  claudeRuntimeManager,
  claudeSessionProviderAdapter,
  ProcessRegistry,
  processRegistry,
  SessionFileLogger,
  SessionManager,
  sessionDataService,
  sessionDomainService,
  sessionFileLogger,
  sessionProcessManager,
  sessionPromptBuilder,
  sessionRepository,
  sessionService,
} from './index';

/**
 * Domain barrel export smoke test.
 *
 * Verifies that every public export from the session domain barrel is a real
 * value (not `undefined` due to circular dependency breakage). Static imports
 * ensure the barrel can be loaded at module resolution time.
 */
describe('session domain barrel exports', () => {
  it('exports core domain service', () => {
    expect(sessionDomainService).toBeDefined();
  });

  it('exports session lifecycle service', () => {
    expect(sessionService).toBeDefined();
  });

  it('exports session process manager', () => {
    expect(sessionProcessManager).toBeDefined();
  });

  it('exports claude runtime manager', () => {
    expect(claudeRuntimeManager).toBeDefined();
    expect(ClaudeRuntimeManager).toBeDefined();
  });

  it('exports claude session provider adapter', () => {
    expect(claudeSessionProviderAdapter).toBeDefined();
    expect(ClaudeSessionProviderAdapter).toBeDefined();
  });

  it('exports session repository', () => {
    expect(sessionRepository).toBeDefined();
  });

  it('exports session prompt builder', () => {
    expect(sessionPromptBuilder).toBeDefined();
  });

  it('exports session data service', () => {
    expect(sessionDataService).toBeDefined();
  });

  it('exports chat connection service', () => {
    expect(chatConnectionService).toBeDefined();
  });

  it('exports chat event forwarder service', () => {
    expect(chatEventForwarderService).toBeDefined();
  });

  it('exports chat message handler service', () => {
    expect(chatMessageHandlerService).toBeDefined();
  });

  it('exports session file logger', () => {
    expect(sessionFileLogger).toBeDefined();
  });

  it('exports SessionFileLogger class', () => {
    expect(SessionFileLogger).toBeDefined();
    expect(typeof SessionFileLogger).toBe('function');
  });

  it('exports ProcessRegistry class', () => {
    expect(ProcessRegistry).toBeDefined();
    expect(typeof ProcessRegistry).toBe('function');
  });

  it('exports processRegistry singleton', () => {
    expect(processRegistry).toBeDefined();
  });

  it('exports SessionManager class', () => {
    expect(SessionManager).toBeDefined();
    expect(typeof SessionManager).toBe('function');
  });

  it('exports ClaudeProcess class', () => {
    expect(ClaudeProcess).toBeDefined();
    expect(typeof ClaudeProcess).toBe('function');
  });
});
