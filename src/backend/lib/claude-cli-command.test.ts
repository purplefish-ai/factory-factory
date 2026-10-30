import { beforeEach, expect, it, vi } from 'vitest';
import { getBundledClaudeCommand } from './claude-cli-command';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('node:module', () => ({ createRequire: () => ({ resolve }) }));

beforeEach(() => {
  resolve.mockReset();
});

it.each([
  [
    '/app/app.asar/node_modules/claude/dist/index.js',
    '/app/app.asar.unpacked/node_modules/claude/dist/index.js',
  ],
  [
    'C:\\app\\app.asar\\node_modules\\claude\\dist\\index.js',
    'C:\\app\\app.asar.unpacked\\node_modules\\claude\\dist\\index.js',
  ],
])('runs the managed CLI outside ASAR: %s', (entrypoint, unpacked) => {
  resolve.mockReturnValue(entrypoint);
  const args = ['auth', 'login', '--console'];
  expect(getBundledClaudeCommand(args)).toEqual({
    command: process.execPath,
    args: [unpacked, '--cli', ...args],
  });
  expect(resolve).toHaveBeenCalledWith('@agentclientprotocol/claude-agent-acp/dist/index.js');
  expect(args).toEqual(['auth', 'login', '--console']);
});

it('reports a missing managed runtime instead of falling back to a global Claude', () => {
  resolve.mockImplementation(() => {
    throw new Error('package missing');
  });
  expect(() => getBundledClaudeCommand(['--version'])).toThrow('package missing');
});
