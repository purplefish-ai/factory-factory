import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { sandboxPaths } from './paths.mjs';
import { startServer } from './server.mjs';
import { temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

describe('the sandbox server process', () => {
  it('drops output that arrives after the sandbox directory is gone', () => {
    const paths = sandboxPaths(temporary.create('ffsb-'));
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout, stderr });
    const server = startServer({
      paths,
      env: {},
      ports: { frontend: 41_001, backend: 41_002 },
      onExit: () => undefined,
      onError: () => undefined,
      spawnImpl: () => child,
    });
    stdout.emit('data', Buffer.from('BACKEND_PORT:41002\n'));
    expect(readFileSync(paths.serverOutput, 'utf8')).toBe('BACKEND_PORT:41002\n');
    expect(server.backendPort).toBe(41_002);
    // The launcher deletes the directory once the group has stopped; the pipes
    // can still deliver what the server wrote before it exited.
    rmSync(paths.baseDir, { recursive: true, force: true });
    expect(() => stdout.emit('data', Buffer.from('late output\n'))).not.toThrow();
    expect(() => stderr.emit('data', Buffer.from('late error\n'))).not.toThrow();
  });
});
