import { afterAll, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => {
  const error = new Error('IPC channel closed');
  const messages: unknown[] = [];
  const callbacks: unknown[] = [];
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    messages.push(_message);
    callbacks.push(callback);
    callback?.(error);
    return false;
  });
  const descriptors = {
    send: Object.getOwnPropertyDescriptor(process, 'send'),
    connected: Object.getOwnPropertyDescriptor(process, 'connected'),
  };
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  return {
    error,
    messages,
    callbacks,
    warnings,
    errors,
    descriptors,
    warn: vi.fn((...args: unknown[]) => warnings.push(args)),
    logError: vi.fn((...args: unknown[]) => errors.push(args)),
  };
});
vi.mock('./app-context', () => ({
  createApplication: () => ({
    services: {
      createLogger: () => ({ warn: startup.warn, error: startup.logError }),
      serverInstanceService: { setInstance: vi.fn() },
    },
  }),
}));
vi.mock('./server', () => ({ createServer: () => ({ start: () => Promise.resolve() }) }));
vi.mock('./shutdown-signal-handlers', () => ({ registerShutdownSignalHandlers: vi.fn() }));
vi.mock('./fatal-error-handlers', () => ({ registerFatalErrorHandlers: vi.fn() }));
import './index';

afterAll(() => {
  for (const [name, descriptor] of Object.entries(startup.descriptors)) {
    if (descriptor) {
      Object.defineProperty(process, name, descriptor);
    } else {
      Reflect.deleteProperty(process, name);
    }
  }
});

it('logs backend-ready delivery errors without treating them as startup failures', async () => {
  await vi.waitFor(() => expect(startup.messages).toEqual([{ type: 'update-backend-ready' }]));
  expect(startup.callbacks).toEqual([expect.any(Function)]);
  expect(startup.warnings).toEqual([
    [
      'Failed to notify update supervisor that backend is ready',
      {
        error: startup.error.message,
      },
    ],
  ]);
  expect(startup.errors).toEqual([]);
});
