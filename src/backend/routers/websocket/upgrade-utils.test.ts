import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { validateWebSocketOrigin } from './upgrade-utils';

function createSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
}

function createLogger() {
  return { warn: vi.fn() };
}

function createConfigService(allowedOrigins: string[]) {
  return {
    getCorsConfig: vi.fn(() => ({ allowedOrigins })),
  };
}

describe('validateWebSocketOrigin', () => {
  it('rejects upgrades without an Origin header', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateWebSocketOrigin({
      request: { headers: {} } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Missing Origin header'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection without Origin header'
    );
  });

  it('rejects upgrades from unauthorized origins', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'https://attacker.example' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'chat WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected chat WebSocket connection from unauthorized origin',
      { origin: 'https://attacker.example' }
    );
  });

  it('allows upgrades from configured origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://localhost:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'snapshots WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('allows upgrades from equivalent loopback origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://127.0.0.1:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('rejects credentialed loopback origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://evil@localhost:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
