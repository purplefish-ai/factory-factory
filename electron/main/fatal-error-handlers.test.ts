import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerFatalErrorHandlers } from './fatal-error-handlers.js';

function createHandlerHarness() {
  const app = {
    quit: vi.fn(),
  };
  const dialog = {
    showErrorBox: vi.fn(),
  };
  const logger = {
    error: vi.fn(),
  };
  const process = new EventEmitter();

  registerFatalErrorHandlers({ app, dialog, logger, process });

  return { app, dialog, logger, process };
}

describe('fatal Electron error handlers', () => {
  it('shows uncaught exceptions and quits after the dialog', () => {
    const { app, dialog, logger, process } = createHandlerHarness();
    const error = new Error('fatal startup failure');

    process.emit('uncaughtException', error);

    expect(logger.error).toHaveBeenCalledWith('[electron] Uncaught exception:', error);
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Uncaught Exception',
      expect.stringContaining('fatal startup failure')
    );
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      app.quit.mock.invocationCallOrder[0]
    );
  });

  it.each(['plain rejection', null, undefined])('shows non-Error rejection %s', (reason) => {
    const { app, dialog, process } = createHandlerHarness();
    process.emit('unhandledRejection', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', String(reason));
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('falls back to the message when an Error has no stack', () => {
    const { dialog, process } = createHandlerHarness();
    const reason = new Error('no stack');
    reason.stack = undefined;
    process.emit('unhandledRejection', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', String(reason));
  });

  it('shows unhandled rejections and quits after the dialog', () => {
    const { app, dialog, logger, process } = createHandlerHarness();
    const reason = new Error('async setup failed');

    process.emit('unhandledRejection', reason);

    expect(logger.error).toHaveBeenCalledWith('[electron] Unhandled rejection:', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', reason.stack);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      app.quit.mock.invocationCallOrder[0]
    );
  });
});
