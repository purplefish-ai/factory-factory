import { beforeEach, expect, it, vi } from 'vitest';
import { getBundledClaudeCommand, getOwnedClaudeCommand } from './claude-cli-command';

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

it('owns the matched native Claude executable on Windows', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    resolve
      .mockReturnValueOnce('/adapter/package.json')
      .mockReturnValueOnce('/sdk/sdk.mjs')
      .mockReturnValueOnce('C:/app/app.asar/node_modules/claude/claude.exe');
    expect(getOwnedClaudeCommand(['auth', 'login'], {})).toEqual({
      command: 'C:/app/app.asar.unpacked/node_modules/claude/claude.exe',
      args: ['auth', 'login'],
    });
    expect(resolve.mock.calls.map(([name]) => name)).toEqual([
      '@agentclientprotocol/claude-agent-acp/package.json',
      '@anthropic-ai/claude-agent-sdk',
      `@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`,
    ]);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

it('preserves an explicit Windows Claude executable override', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(
      getOwnedClaudeCommand(['auth', 'login'], { CLAUDE_CODE_EXECUTABLE: 'C:/custom/claude.exe' })
    ).toEqual({ command: 'C:/custom/claude.exe', args: ['auth', 'login'] });
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
