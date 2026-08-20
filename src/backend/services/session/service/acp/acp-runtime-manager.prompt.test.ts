import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AcpRuntimeManager,
  createManagerTestHarness,
  mockCancel,
  mockPrompt,
  PromptTimeoutError,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

describe('PromptTimeoutError', () => {
  it('retains the caller-specified timeout for durable classification', () => {
    const error = new PromptTimeoutError('session-1', 300_000);

    expect((error as PromptTimeoutError & { timeoutMs?: number }).timeoutMs).toBe(300_000);
  });
});

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    ({ manager } = createManagerTestHarness());
  });

  describe('sendPrompt', () => {
    it('sets isPromptInFlight, calls connection.prompt, clears flag on resolve', async () => {
      setupSuccessfulSpawn();
      mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(handle.isPromptInFlight).toBe(false);

      const result = await manager.sendPrompt('session-1', [{ type: 'text', text: 'Hello world' }]);

      expect(mockPrompt).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        prompt: [{ type: 'text', text: 'Hello world' }],
      });
      expect(result.stopReason).toBe('end_turn');
      expect(handle.isPromptInFlight).toBe(false);
    });

    it('clears isPromptInFlight on error', async () => {
      setupSuccessfulSpawn();
      mockPrompt.mockRejectedValue(new Error('prompt failed'));

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(
        manager.sendPrompt('session-1', [{ type: 'text', text: 'Hello' }])
      ).rejects.toThrow('prompt failed');
      expect(handle.isPromptInFlight).toBe(false);
    });

    it('releases the in-flight flag after cancelling on prompt timeout', async () => {
      setupSuccessfulSpawn();
      mockPrompt.mockReturnValue(new Promise(() => undefined));
      mockCancel.mockResolvedValue(undefined);

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      vi.useFakeTimers();

      try {
        const promptPromise = manager.sendPrompt(
          'session-1',
          [{ type: 'text', text: 'Hello' }],
          100
        );
        const promptRejection = promptPromise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(100);

        await expect(promptRejection).resolves.toBeInstanceOf(PromptTimeoutError);
        expect(mockCancel).toHaveBeenCalledWith({
          sessionId: 'provider-session-123',
        });
        expect(handle.isPromptInFlight).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops the client when prompt timeout cancellation hangs', async () => {
      const child = setupSuccessfulSpawn();
      mockPrompt.mockReturnValue(new Promise(() => undefined));
      mockCancel.mockReturnValue(new Promise(() => undefined));

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      child.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGTERM') {
          child.killed = true;
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
        return true;
      });

      vi.useFakeTimers();

      try {
        const promptPromise = manager.sendPrompt(
          'session-1',
          [{ type: 'text', text: 'Hello' }],
          100
        );
        const promptRejection = promptPromise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(100);
        expect(mockCancel).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5000);

        await expect(promptRejection).resolves.toBeInstanceOf(PromptTimeoutError);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(manager.getClient('session-1')).toBeUndefined();
        expect(handle.isPromptInFlight).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not clear or stop a replacement session when timeout cancel hangs', async () => {
      const firstChild = setupSuccessfulSpawn();
      mockPrompt.mockReturnValue(new Promise(() => undefined));
      mockCancel.mockReturnValue(new Promise(() => undefined));

      const firstHandle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      vi.useFakeTimers();

      try {
        const stalePrompt = manager.sendPrompt(
          'session-1',
          [{ type: 'text', text: 'old prompt' }],
          100
        );
        const staleRejection = stalePrompt.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(100);
        expect(mockCancel).toHaveBeenCalledTimes(1);

        firstChild.exitCode = 1;
        firstChild.emit('exit', 1, null);
        await vi.waitFor(() => expect(manager.getClient('session-1')).toBeUndefined());

        const replacementChild = setupSuccessfulSpawn();
        const replacementHandle = await manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
        replacementHandle.isPromptInFlight = true;

        await vi.advanceTimersByTimeAsync(5000);

        await expect(staleRejection).resolves.toBeInstanceOf(PromptTimeoutError);
        expect(replacementHandle.isPromptInFlight).toBe(true);
        expect(replacementChild.kill).not.toHaveBeenCalled();
        expect(manager.getClient('session-1')).toBe(replacementHandle);
        expect(firstHandle.isPromptInFlight).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not cancel a replacement session when an old prompt timeout fires', async () => {
      const firstChild = setupSuccessfulSpawn();
      mockPrompt.mockReturnValueOnce(new Promise(() => undefined));
      mockCancel.mockResolvedValue(undefined);

      const firstHandle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      firstChild.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGTERM') {
          firstChild.killed = true;
          firstChild.exitCode = 0;
          firstChild.emit('exit', 0, null);
        }
        return true;
      });

      vi.useFakeTimers();

      try {
        const stalePrompt = manager.sendPrompt(
          'session-1',
          [{ type: 'text', text: 'old prompt' }],
          100
        );
        const staleRejection = stalePrompt.catch((error: unknown) => error);

        await manager.stopClient('session-1');
        expect(manager.getClient('session-1')).toBeUndefined();

        const replacementPrompt = createDeferred<{ stopReason: string }>();
        setupSuccessfulSpawn();
        mockPrompt.mockReturnValueOnce(replacementPrompt.promise);
        const replacementHandle = await manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
        const replacementSend = manager.sendPrompt('session-1', [
          { type: 'text', text: 'new prompt' },
        ]);
        await Promise.resolve();

        expect(replacementHandle.isPromptInFlight).toBe(true);
        const cancelCallsBeforeStaleTimeout = mockCancel.mock.calls.length;

        await vi.advanceTimersByTimeAsync(100);

        await expect(staleRejection).resolves.toBeInstanceOf(PromptTimeoutError);
        expect(mockCancel).toHaveBeenCalledTimes(cancelCallsBeforeStaleTimeout);
        expect(replacementHandle.isPromptInFlight).toBe(true);
        expect(firstHandle.isPromptInFlight).toBe(false);

        replacementPrompt.resolve({ stopReason: 'end_turn' });
        await expect(replacementSend).resolves.toEqual({ stopReason: 'end_turn' });
        expect(replacementHandle.isPromptInFlight).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws if no session found', async () => {
      await expect(
        manager.sendPrompt('nonexistent', [{ type: 'text', text: 'Hello' }])
      ).rejects.toThrow('No ACP session found');
    });
  });

  describe('cancelPrompt', () => {
    it('calls connection.cancel when prompt is in flight', async () => {
      setupSuccessfulSpawn();
      mockCancel.mockResolvedValue(undefined);

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      handle.isPromptInFlight = true;

      const cancelled = await manager.cancelPrompt('session-1');

      expect(mockCancel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
      });
      expect(cancelled).toBe(true);
    });

    it('does nothing when no prompt is in flight', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      const cancelled = await manager.cancelPrompt('session-1');

      expect(mockCancel).not.toHaveBeenCalled();
      expect(cancelled).toBe(false);
    });

    it('does nothing for nonexistent session', async () => {
      const cancelled = await manager.cancelPrompt('nonexistent');
      expect(mockCancel).not.toHaveBeenCalled();
      expect(cancelled).toBe(false);
    });
  });
});
