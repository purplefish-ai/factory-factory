import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { validateTrustedLocalWebSocketRequest, validateWebSocketOrigin } from './upgrade-utils';

function createSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
}

function createLogger() {
  return { warn: vi.fn() };
}

function createConfigService(allowedOrigins: string[], trustedLocalCidrs: string[] = []) {
  return {
    getCorsConfig: vi.fn(() => ({ allowedOrigins, trustedLocalCidrs })),
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

describe('validateTrustedLocalWebSocketRequest', () => {
  it('rejects untrusted remote addresses', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: {},
        socket: { remoteAddress: '203.0.113.10' },
      } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection from untrusted remote address',
      { remoteAddress: '203.0.113.10' }
    );
  });

  it('rejects forwarded client address headers from trusted peer addresses', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Forwarded WebSocket upgrades are not trusted')
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection with forwarded client address headers',
      {
        forwardedClientAddressHeaders: ['x-forwarded-for'],
        remoteAddress: '127.0.0.1',
      }
    );
  });

  it('allows trusted local requests without forwarded client address headers', () => {
    const socket = createSocket();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: {},
        socket: { remoteAddress: '172.17.0.1' },
      } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000'], ['172.17.0.1/32']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
