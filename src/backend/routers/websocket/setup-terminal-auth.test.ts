import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { createSetupTerminalUpgradeHandler } from './setup-terminal.handler';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), claude: vi.fn(), codex: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ spawn: mocks.spawn }) }));
vi.mock('@/backend/lib/claude-cli-command', () => ({ getBundledClaudeCommand: mocks.claude }));
vi.mock('@/backend/lib/codex-cli-command', () => ({ getBundledCodexCommand: mocks.codex }));

function terminal() {
  return {
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

function connect() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn() });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const appContext = {
    services: {
      createLogger: () => logger,
      configService: {
        getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
        getShellPath: () => '/bin/zsh',
        getChildProcessEnv: () => ({ PATH: '', FACTORY_RUNTIME: 'preserved' }),
      },
    },
  } as unknown as AppContext;
  createSetupTerminalUpgradeHandler(appContext)(
    {
      headers: { origin: 'http://localhost:3000' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage,
    { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
    Buffer.alloc(0),
    new URL('http://localhost/setup-terminal'),
    {
      handleUpgrade: (_request, _socket, _head, callback) =>
        callback(ws as unknown as WebSocket, _request),
    } as WebSocketServer,
    new WeakMap()
  );
  return ws;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claude.mockReturnValue({
    command: '/app/Electron',
    args: ['/app/claude-agent-acp.js', '--cli', 'auth', 'login'],
  });
  mocks.codex.mockReturnValue({
    command: '/app/Electron',
    args: ['/app/codex-acp.js', 'cli', 'login'],
  });
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'runs managed %s login directly without a global ff or Node',
  (provider) => {
    const shell = terminal();
    const auth = terminal();
    mocks.spawn.mockReturnValueOnce(shell).mockReturnValueOnce(auth);
    const ws = connect();
    ws.emit('message', JSON.stringify({ type: 'create' }));
    ws.emit('message', JSON.stringify({ type: 'authenticate', provider, cols: 120, rows: 40 }));
    const resolver = provider === 'CLAUDE' ? mocks.claude : mocks.codex;
    expect(resolver).toHaveBeenCalledWith(provider === 'CLAUDE' ? ['auth', 'login'] : ['login']);
    expect(shell.kill).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      '/app/Electron',
      resolver.mock.results[0]?.value.args,
      expect.objectContaining({
        cols: 120,
        rows: 40,
        env: expect.objectContaining({
          PATH: '',
          FACTORY_RUNTIME: 'preserved',
          ELECTRON_RUN_AS_NODE: '1',
        }),
      })
    );
    ws.send.mockClear();
    shell.onExit.mock.calls[0]?.[0]({ exitCode: 0 });
    shell.onData.mock.calls[0]?.[0]('stale shell output');
    expect(ws.send).not.toHaveBeenCalled();
    ws.emit('message', JSON.stringify({ type: 'input', data: 'login input\r' }));
    expect(auth.write).toHaveBeenCalledWith('login input\r');
    ws.emit('close');
    expect(auth.kill).toHaveBeenCalledOnce();
  }
);

it('rejects unknown authentication providers before replacing the terminal', () => {
  const ws = connect();
  ws.emit('message', JSON.stringify({ type: 'authenticate', provider: 'UNKNOWN' }));
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(ws.send).toHaveBeenCalledWith(
    JSON.stringify({ type: 'error', message: 'Invalid message format' })
  );
});
