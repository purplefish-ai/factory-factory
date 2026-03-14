import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE importing the service module
// ---------------------------------------------------------------------------

const mockPtyWrite = vi.fn();
const mockPtyResize = vi.fn();
const mockPtyKill = vi.fn();

let onDataCallback: ((data: string) => void) | null = null;
let onExitCallback: ((e: { exitCode: number }) => void) | null = null;

const mockPtyOnData = vi.fn().mockImplementation((cb: (data: string) => void) => {
  onDataCallback = cb;
  return { dispose: vi.fn() };
});

const mockPtyOnExit = vi.fn().mockImplementation((cb: (e: { exitCode: number }) => void) => {
  onExitCallback = cb;
  return { dispose: vi.fn() };
});

const mockPtySpawn = vi.fn().mockImplementation(() => ({
  pid: 12_345,
  onData: mockPtyOnData,
  onExit: mockPtyOnExit,
  write: mockPtyWrite,
  resize: mockPtyResize,
  kill: mockPtyKill,
}));

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id === 'node-pty') {
      return { spawn: mockPtySpawn };
    }
    throw new Error(`Unexpected require: ${id}`);
  },
}));

vi.mock('pidusage', () => ({
  default: vi.fn().mockResolvedValue({ cpu: 1.5, memory: 1024 }),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { TerminalService } from './terminal.service';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('TerminalService', () => {
  let service: TerminalService;

  const defaultOpts = {
    workspaceId: 'ws-1',
    workingDir: '/tmp',
    cols: 80,
    rows: 24,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onDataCallback = null;
    onExitCallback = null;
    service = new TerminalService();
  });

  afterEach(() => {
    service.cleanup();
  });

  // =========================================================================
  // createTerminal
  // =========================================================================
  describe('createTerminal', () => {
    it('calls node-pty spawn with correct arguments', async () => {
      const result = await service.createTerminal(defaultOpts);

      expect(mockPtySpawn).toHaveBeenCalledWith(
        expect.any(String), // shell path
        [], // shell args
        expect.objectContaining({
          cols: 80,
          rows: 24,
          cwd: '/tmp',
        })
      );
      expect(result).toEqual({ terminalId: expect.any(String), pid: 12_345 });
    });

    it('returns terminalId and pid on success', async () => {
      const { terminalId, pid } = await service.createTerminal(defaultOpts);
      expect(terminalId).toMatch(/^term-/);
      expect(pid).toBe(12_345);
    });

    it('registers onData and onExit handlers on the PTY', async () => {
      await service.createTerminal(defaultOpts);
      expect(mockPtyOnData).toHaveBeenCalledTimes(1);
      expect(mockPtyOnExit).toHaveBeenCalledTimes(1);
    });

    it('uses custom shell when provided', async () => {
      await service.createTerminal({ ...defaultOpts, shell: '/bin/zsh' });
      expect(mockPtySpawn).toHaveBeenCalledWith('/bin/zsh', [], expect.any(Object));
    });
  });

  // =========================================================================
  // writeToTerminal
  // =========================================================================
  describe('writeToTerminal', () => {
    it('returns true and calls pty.write when terminal exists', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const result = service.writeToTerminal('ws-1', terminalId, 'ls\n');
      expect(result).toBe(true);
      expect(mockPtyWrite).toHaveBeenCalledWith('ls\n');
    });

    it('returns false when terminal does not exist', () => {
      expect(service.writeToTerminal('ws-1', 'nonexistent', 'data')).toBe(false);
    });
  });

  // =========================================================================
  // resizeTerminal
  // =========================================================================
  describe('resizeTerminal', () => {
    it('returns true and calls pty.resize when terminal exists', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const result = service.resizeTerminal('ws-1', terminalId, 120, 40);
      expect(result).toBe(true);
      expect(mockPtyResize).toHaveBeenCalledWith(120, 40);
    });

    it('updates stored cols/rows', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      service.resizeTerminal('ws-1', terminalId, 120, 40);
      const instance = service.getTerminal('ws-1', terminalId);
      expect(instance?.cols).toBe(120);
      expect(instance?.rows).toBe(40);
    });

    it('returns false when terminal does not exist', () => {
      expect(service.resizeTerminal('ws-1', 'nonexistent', 120, 40)).toBe(false);
    });
  });

  // =========================================================================
  // destroyTerminal
  // =========================================================================
  describe('destroyTerminal', () => {
    it('returns true and calls pty.kill when terminal exists', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const result = service.destroyTerminal('ws-1', terminalId);
      expect(result).toBe(true);
      expect(mockPtyKill).toHaveBeenCalled();
    });

    it('cleans up listeners and removes from internal maps', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      service.destroyTerminal('ws-1', terminalId);
      expect(service.getTerminal('ws-1', terminalId)).toBeNull();
    });

    it('returns false when terminal does not exist', () => {
      expect(service.destroyTerminal('ws-1', 'nonexistent')).toBe(false);
    });

    it('returns false when workspace does not exist', () => {
      expect(service.destroyTerminal('unknown-ws', 'nonexistent')).toBe(false);
    });

    it('clears retained output buffer contents before destroying terminal', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      onDataCallback?.('A'.repeat(16 * 1024));
      const instance = service.getTerminal('ws-1', terminalId);
      expect(instance?.outputBuffer.length).toBe(16 * 1024);

      service.destroyTerminal('ws-1', terminalId);

      // Instance references can outlive map membership; clear to release memory eagerly.
      expect(instance?.outputBuffer).toBe('');
    });
  });

  // =========================================================================
  // getTerminal / getTerminalsForWorkspace
  // =========================================================================
  describe('getTerminal', () => {
    it('returns the terminal instance after creation', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const instance = service.getTerminal('ws-1', terminalId);
      expect(instance).not.toBeNull();
      expect(instance?.id).toBe(terminalId);
    });

    it('returns null for unknown workspace', () => {
      expect(service.getTerminal('unknown', 'id')).toBeNull();
    });

    it('returns null for unknown terminal in valid workspace', async () => {
      await service.createTerminal(defaultOpts);
      expect(service.getTerminal('ws-1', 'nonexistent')).toBeNull();
    });
  });

  describe('getTerminalsForWorkspace', () => {
    it('returns all terminals for workspace', async () => {
      await service.createTerminal(defaultOpts);
      await service.createTerminal({ ...defaultOpts });
      const terminals = service.getTerminalsForWorkspace('ws-1');
      expect(terminals).toHaveLength(2);
    });

    it('returns empty array for unknown workspace', () => {
      expect(service.getTerminalsForWorkspace('unknown')).toEqual([]);
    });
  });

  // =========================================================================
  // onOutput / onExit listeners
  // =========================================================================
  describe('onOutput', () => {
    it('registers listener and fires on data', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      service.onOutput(terminalId, listener);

      // Simulate PTY data
      onDataCallback?.('hello');
      expect(listener).toHaveBeenCalledWith('hello');
    });

    it('returns unsubscribe function that removes listener', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      const unsub = service.onOutput(terminalId, listener);

      unsub();
      onDataCallback?.('hello');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('onExit', () => {
    it('registers listener and fires on exit', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      service.onExit(terminalId, listener);

      // Simulate PTY exit
      onExitCallback?.({ exitCode: 0 });
      expect(listener).toHaveBeenCalledWith(0);
    });

    it('returns unsubscribe function that removes listener', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      const unsub = service.onExit(terminalId, listener);

      unsub();
      onExitCallback?.({ exitCode: 0 });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // destroyWorkspaceTerminals
  // =========================================================================
  describe('destroyWorkspaceTerminals', () => {
    it('destroys all terminals for a given workspace', async () => {
      await service.createTerminal(defaultOpts);
      await service.createTerminal(defaultOpts);
      expect(service.getTerminalsForWorkspace('ws-1')).toHaveLength(2);

      service.destroyWorkspaceTerminals('ws-1');
      expect(service.getTerminalsForWorkspace('ws-1')).toHaveLength(0);
    });

    it('is a no-op for unknown workspace', () => {
      // Should not throw
      service.destroyWorkspaceTerminals('unknown');
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================
  describe('cleanup', () => {
    it('destroys all terminals across all workspaces', async () => {
      await service.createTerminal(defaultOpts);
      await service.createTerminal({ ...defaultOpts, workspaceId: 'ws-2' });
      expect(service.getActiveTerminalCount()).toBe(2);

      service.cleanup();
      expect(service.getActiveTerminalCount()).toBe(0);
    });
  });

  // =========================================================================
  // getActiveTerminalCount
  // =========================================================================
  describe('getActiveTerminalCount', () => {
    it('returns 0 initially', () => {
      expect(service.getActiveTerminalCount()).toBe(0);
    });

    it('increments after createTerminal', async () => {
      await service.createTerminal(defaultOpts);
      expect(service.getActiveTerminalCount()).toBe(1);
    });

    it('decrements after destroyTerminal', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      service.destroyTerminal('ws-1', terminalId);
      expect(service.getActiveTerminalCount()).toBe(0);
    });
  });

  // =========================================================================
  // setActiveTerminal / getActiveTerminal / clearActiveTerminal
  // =========================================================================
  describe('setActiveTerminal / getActiveTerminal / clearActiveTerminal', () => {
    it('sets and gets the active terminal for a workspace', () => {
      service.setActiveTerminal('ws-1', 'term-abc');
      expect(service.getActiveTerminal('ws-1')).toBe('term-abc');
    });

    it('returns null when no active terminal is set', () => {
      expect(service.getActiveTerminal('ws-1')).toBeNull();
    });

    it('clears the active terminal', () => {
      service.setActiveTerminal('ws-1', 'term-abc');
      service.clearActiveTerminal('ws-1');
      expect(service.getActiveTerminal('ws-1')).toBeNull();
    });
  });

  // =========================================================================
  // getAllTerminals
  // =========================================================================
  describe('getAllTerminals', () => {
    it('returns empty array initially', () => {
      expect(service.getAllTerminals()).toEqual([]);
    });

    it('returns all terminals across workspaces', async () => {
      await service.createTerminal(defaultOpts);
      await service.createTerminal({ ...defaultOpts, workspaceId: 'ws-2' });
      const all = service.getAllTerminals();
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          pid: 12_345,
          cols: 80,
          rows: 24,
        })
      );
    });
  });

  // =========================================================================
  // Output buffer truncation
  // =========================================================================
  describe('output buffer management', () => {
    it('truncates output buffer when exceeding MAX_OUTPUT_BUFFER_SIZE', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);

      // Simulate large output (over 100KB limit)
      const bigChunk = 'A'.repeat(80 * 1024);
      onDataCallback?.(bigChunk);

      const moreData = 'B'.repeat(50 * 1024);
      onDataCallback?.(moreData);

      const instance = service.getTerminal('ws-1', terminalId);
      // Buffer should be capped at 100KB
      expect(instance?.outputBuffer.length).toBe(100 * 1024);
      // Should end with the most recent data
      expect(instance?.outputBuffer.endsWith('B'.repeat(50 * 1024))).toBe(true);
    });

    it('preserves output buffer below the limit', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);

      onDataCallback?.('hello world');

      const instance = service.getTerminal('ws-1', terminalId);
      expect(instance?.outputBuffer).toBe('hello world');
    });

    it('accumulates output across multiple data events', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);

      onDataCallback?.('line1\n');
      onDataCallback?.('line2\n');
      onDataCallback?.('line3\n');

      const instance = service.getTerminal('ws-1', terminalId);
      expect(instance?.outputBuffer).toBe('line1\nline2\nline3\n');
    });
  });

  // =========================================================================
  // Exit auto-cleanup
  // =========================================================================
  describe('exit auto-cleanup', () => {
    it('automatically destroys terminal on PTY exit', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      expect(service.getTerminal('ws-1', terminalId)).not.toBeNull();

      // Simulate PTY exit
      onExitCallback?.({ exitCode: 0 });

      expect(service.getTerminal('ws-1', terminalId)).toBeNull();
      expect(service.getActiveTerminalCount()).toBe(0);
    });

    it('clears workspace terminal map when last terminal exits', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);

      onExitCallback?.({ exitCode: 1 });

      expect(service.getTerminalsForWorkspace('ws-1')).toHaveLength(0);
      expect(service.getTerminal('ws-1', terminalId)).toBeNull();
    });

    it('does not destroy other terminals when one exits', async () => {
      await service.createTerminal(defaultOpts);
      // Create a second terminal - need fresh callbacks
      const secondCallbacks: {
        onData?: (d: string) => void;
        onExit?: (e: { exitCode: number }) => void;
      } = {};
      mockPtyOnData.mockImplementationOnce((cb: (data: string) => void) => {
        secondCallbacks.onData = cb;
        return { dispose: vi.fn() };
      });
      mockPtyOnExit.mockImplementationOnce((cb: (e: { exitCode: number }) => void) => {
        secondCallbacks.onExit = cb;
        return { dispose: vi.fn() };
      });
      await service.createTerminal(defaultOpts);

      expect(service.getTerminalsForWorkspace('ws-1')).toHaveLength(2);

      // Exit only the first terminal
      onExitCallback?.({ exitCode: 0 });

      expect(service.getTerminalsForWorkspace('ws-1')).toHaveLength(1);
    });
  });

  // =========================================================================
  // Active terminal cleared on destroy
  // =========================================================================
  describe('active terminal cleanup on destroy', () => {
    it('clears active terminal when the active terminal is destroyed', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      service.setActiveTerminal('ws-1', terminalId);
      expect(service.getActiveTerminal('ws-1')).toBe(terminalId);

      service.destroyTerminal('ws-1', terminalId);
      expect(service.getActiveTerminal('ws-1')).toBeNull();
    });

    it('does not clear active terminal when a different terminal is destroyed', async () => {
      const { terminalId: firstId } = await service.createTerminal(defaultOpts);
      const { terminalId: secondId } = await service.createTerminal(defaultOpts);
      service.setActiveTerminal('ws-1', firstId);

      service.destroyTerminal('ws-1', secondId);
      expect(service.getActiveTerminal('ws-1')).toBe(firstId);
    });
  });

  // =========================================================================
  // Multiple listeners
  // =========================================================================
  describe('multiple listeners', () => {
    it('fires all output listeners for a terminal', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      service.onOutput(terminalId, listener1);
      service.onOutput(terminalId, listener2);

      onDataCallback?.('test');

      expect(listener1).toHaveBeenCalledWith('test');
      expect(listener2).toHaveBeenCalledWith('test');
    });

    it('fires all exit listeners for a terminal', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      service.onExit(terminalId, listener1);
      service.onExit(terminalId, listener2);

      onExitCallback?.({ exitCode: 42 });

      expect(listener1).toHaveBeenCalledWith(42);
      expect(listener2).toHaveBeenCalledWith(42);
    });
  });

  // =========================================================================
  // Listener cleanup edge cases
  // =========================================================================
  describe('listener cleanup edge cases', () => {
    it('unsubscribing output listener that was already removed is a no-op', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      const unsub = service.onOutput(terminalId, listener);

      // Destroy terminal clears all listeners
      service.destroyTerminal('ws-1', terminalId);

      // Unsubscribe after destroy should not throw
      expect(() => unsub()).not.toThrow();
    });

    it('unsubscribing exit listener that was already removed is a no-op', async () => {
      const { terminalId } = await service.createTerminal(defaultOpts);
      const listener = vi.fn();
      const unsub = service.onExit(terminalId, listener);

      service.destroyTerminal('ws-1', terminalId);

      expect(() => unsub()).not.toThrow();
    });

    it('registering listener for non-existent terminal does not throw', () => {
      const unsub = service.onOutput('nonexistent', vi.fn());
      expect(() => unsub()).not.toThrow();
    });
  });
});
