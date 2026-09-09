import type { ContentBlock } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpPermissionBridge } from './acp-permission-bridge';
import { AcpPromptController, type AcpPromptRuntimePort } from './acp-prompt-controller';
import { PromptTimeoutError } from './acp-runtime-errors';
import { createTestProcessHandle } from './acp-runtime-manager.test-helpers';

const sessionId = 'session-1';
const prompt: ContentBlock[] = [{ type: 'text', text: 'Hello world' }];

describe('AcpPromptController', () => {
  let runtimePort: AcpPromptRuntimePort;
  let controller: AcpPromptController;

  beforeEach(() => {
    runtimePort = {
      isCurrentHandle: vi.fn(() => true),
      stopClient: vi.fn().mockResolvedValue(undefined),
    };
    controller = new AcpPromptController(runtimePort);
  });

  it.each(['soft stop', 'timeout'])('cancels pending permission responses on %s', async (mode) => {
    const bridge = new AcpPermissionBridge();
    const response = bridge.waitForUserResponse('request-1', {
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Command' },
      options: [],
    });
    const handle = Object.assign(
      createTestProcessHandle({
        connection: {
          prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
          cancel: vi.fn().mockResolvedValue(undefined),
        },
      }),
      { permissionBridge: bridge }
    );
    handle.isPromptInFlight = true;
    vi.useFakeTimers();
    try {
      if (mode === 'soft stop') {
        await controller.cancelPrompt(sessionId, handle);
      } else {
        const sending = controller
          .sendPrompt(sessionId, handle, prompt, 100)
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(100);
        await expect(sending).resolves.toBeInstanceOf(PromptTimeoutError);
      }
      expect(bridge.pendingCount).toBe(0);
      await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      expect(runtimePort.stopClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the provider stop reason and clears the in-flight marker after a prompt resolves', async () => {
    const connection = {
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    };
    const handle = createTestProcessHandle({ connection });

    await expect(controller.sendPrompt(sessionId, handle, prompt)).resolves.toEqual({
      stopReason: 'end_turn',
    });

    expect(handle.isPromptInFlight).toBe(false);
    expect(connection.prompt).toHaveBeenCalledWith({
      sessionId: 'provider-session-1',
      prompt,
    });
  });

  it('preserves a prompt rejection and clears the in-flight marker', async () => {
    const connection = {
      prompt: vi.fn().mockRejectedValue(new Error('prompt failed')),
    };
    const handle = createTestProcessHandle({ connection });

    await expect(controller.sendPrompt(sessionId, handle, prompt)).rejects.toThrow('prompt failed');

    expect(handle.isPromptInFlight).toBe(false);
  });

  it('does not cancel when no handle was supplied', async () => {
    await expect(controller.cancelPrompt(sessionId, undefined)).resolves.toBe(false);
  });

  it('leaves permissions untouched when asked to cancel a stale handle', async () => {
    const bridge = new AcpPermissionBridge();
    void bridge.waitForUserResponse('request-1', {
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tool-1' },
      options: [],
    });
    const connection = { cancel: vi.fn() };
    const handle = Object.assign(createTestProcessHandle({ connection }), {
      permissionBridge: bridge,
    });
    handle.isPromptInFlight = true;
    runtimePort.isCurrentHandle = vi.fn(() => false);
    await expect(controller.cancelPrompt(sessionId, handle)).resolves.toBe(false);
    expect(bridge.hasPending('request-1')).toBe(true);
    expect(connection.cancel).not.toHaveBeenCalled();
    bridge.cancelAll();
  });

  it('does not cancel a handle without an in-flight prompt', async () => {
    const connection = { cancel: vi.fn() };
    const handle = createTestProcessHandle({ connection });

    await expect(controller.cancelPrompt(sessionId, handle)).resolves.toBe(false);

    expect(connection.cancel).not.toHaveBeenCalled();
  });

  it('cancels an in-flight prompt on the supplied handle', async () => {
    const connection = { cancel: vi.fn().mockResolvedValue(undefined) };
    const handle = createTestProcessHandle({ connection });
    handle.isPromptInFlight = true;

    await expect(controller.cancelPrompt(sessionId, handle)).resolves.toBe(true);

    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'provider-session-1' });
  });

  it('cancels the timed-out prompt without stopping its runtime when cancellation succeeds', async () => {
    const connection = {
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const handle = createTestProcessHandle({ connection });
    vi.useFakeTimers();

    try {
      const sending = controller.sendPrompt(sessionId, handle, prompt, 100);
      const rejection = sending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);

      await expect(rejection).resolves.toMatchObject({
        name: 'PromptTimeoutError',
        timeoutMs: 100,
      });
      expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'provider-session-1' });
      expect(runtimePort.stopClient).not.toHaveBeenCalled();
      expect(handle.isPromptInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the runtime after timed-out prompt cancellation fails', async () => {
    const connection = {
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn().mockRejectedValue(new Error('cancel failed')),
    };
    const handle = createTestProcessHandle({ connection });
    vi.useFakeTimers();

    try {
      const sending = controller.sendPrompt(sessionId, handle, prompt, 100);
      const rejection = sending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);

      await expect(rejection).resolves.toBeInstanceOf(PromptTimeoutError);
      expect(runtimePort.stopClient).toHaveBeenCalledWith(sessionId);
      expect(handle.isPromptInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the runtime after cancellation hangs for five seconds', async () => {
    const connection = {
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const handle = createTestProcessHandle({ connection });
    vi.useFakeTimers();

    try {
      const sending = controller.sendPrompt(sessionId, handle, prompt, 100);
      const rejection = sending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);
      expect(runtimePort.stopClient).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);

      await expect(rejection).resolves.toBeInstanceOf(PromptTimeoutError);
      expect(runtimePort.stopClient).toHaveBeenCalledWith(sessionId);
      expect(handle.isPromptInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel, clear, or stop a replacement after an old prompt times out', async () => {
    const connection = {
      prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const handle = createTestProcessHandle({ connection });
    runtimePort.isCurrentHandle = vi.fn(() => false);
    vi.useFakeTimers();

    try {
      const sending = controller.sendPrompt(sessionId, handle, prompt, 100);
      const rejection = sending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);

      await expect(rejection).resolves.toBeInstanceOf(PromptTimeoutError);
      expect(connection.cancel).not.toHaveBeenCalled();
      expect(runtimePort.stopClient).not.toHaveBeenCalled();
      expect(handle.isPromptInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
