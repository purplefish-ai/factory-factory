import { describe, expect, it } from 'vitest';
import type { PairedToolCall } from '@/lib/chat-protocol';
import { getToolGroupLabel } from './tool-activity-summary';

function call(name: string, input: Record<string, unknown>): PairedToolCall {
  return { id: 'tool', name, input, status: 'success' };
}

describe('compact activity summaries', () => {
  it.each([
    ["python3 - <<'PY'\nimport subprocess\nPY", 'Ran python3'],
    ['/usr/bin/python3 /tmp/check.py', 'Ran python3'],
    ['git cherry-pick 5ca9a1b', 'Ran git cherry-pick'],
    ['git -C "/tmp/a project" diff HEAD --stat | tail -10', 'Ran git diff'],
    ['git --git-dir=/tmp/repo/.git -c core.pager=cat log -1', 'Ran git log'],
    ['FOO=bar /usr/local/bin/pnpm test --run', 'Ran pnpm test'],
    ['rg -n pattern /project/src', 'Ran rg'],
    ['cat /tmp/result.txt', 'Ran cat'],
    ['gh --repo owner/repo pr view 123', 'Ran gh pr'],
    ['pnpm --workspace-root test', 'Ran pnpm test'],
    ['sh -lc "git -C /tmp/repo status --short"', 'Ran git status'],
    ["sh -ec 'git status'", 'Ran git status'],
    ['bash -euc "python3 /tmp/check.py"', 'Ran python3'],
    ['"C:\\Program Files\\Git\\bin\\git.exe" status --short', 'Ran git status'],
    ['git\nprintf status', 'Ran git'],
    ['docker --log-level debug ps', 'Ran docker ps'],
    ['git --unknown-option value status', 'Ran git'],
    ['git --no-pager status', 'Ran git status'],
    ['', 'Ran command'],
  ])('condenses %s to %s', (command, expected) => {
    expect(getToolGroupLabel([call('Bash', { command })])).toBe(expected);
  });

  it('supports Codex shell arrays, cmd inputs and run-name fallbacks', () => {
    expect(
      getToolGroupLabel([
        call('Run', { command: ['/bin/zsh', '-lc', 'git -C /tmp/repo cherry-pick abc'] }),
      ])
    ).toBe('Ran git cherry-pick');
    expect(
      getToolGroupLabel([call('exec_command', { cmd: '/usr/bin/python3 -c "print(1)"' })])
    ).toBe('Ran python3');
    expect(getToolGroupLabel([call('Run git cherry-pick abc', {})])).toBe('Ran git cherry-pick');
    expect(
      getToolGroupLabel([
        call('Run', { command: ['git', '-C', '/tmp/a project', 'diff', '--stat'] }),
      ])
    ).toBe('Ran git diff');
  });

  it('uses filenames for one read and a generic label for multiple reads', () => {
    const read = call('Read', { file_path: '/project/src/Button.tsx' });
    expect(getToolGroupLabel([read])).toBe('Read file Button.tsx');
    expect(getToolGroupLabel([read, call('read_file', { path: '/project/src/Input.tsx' })])).toBe(
      'Read files'
    );
    expect(getToolGroupLabel([call('Read', {})])).toBe('Read files');
  });

  it('condenses Windows executable names in command arrays', () => {
    expect(
      getToolGroupLabel([
        call('Run', { command: ['C:\\Program Files\\Git\\bin\\git.EXE', 'cherry-pick', 'abc'] }),
      ])
    ).toBe('Ran git cherry-pick');
    expect(
      getToolGroupLabel([call('Run', { command: ['C:\\Python313\\python.exe', 'check.py'] })])
    ).toBe('Ran python');
    expect(getToolGroupLabel([call('Run', { command: ['/bin/sh', '-ec', 'git status'] })])).toBe(
      'Ran git status'
    );
  });

  it('rolls up commands without listing executables or arguments', () => {
    expect(
      getToolGroupLabel([
        call('Read', { path: '/project/a.ts' }),
        call('Bash', { command: 'git status' }),
        call('exec_command', { cmd: 'python3 check.py' }),
      ])
    ).toBe('Read file a.ts, ran commands');
  });

  it('recognizes command inputs when adapters use a command or description as the tool name', () => {
    const command = call('git -C /tmp/project diff HEAD --stat', {
      command: 'git -C /tmp/project diff HEAD --stat',
    });
    expect(getToolGroupLabel([command])).toBe('Ran git diff');
    expect(
      getToolGroupLabel([command, call('grep foo a.txt', { command: 'grep foo a.txt' })])
    ).toBe('Ran commands');
    expect(getToolGroupLabel([command, call('Guardian Review', { cmd: 'cubic review' })])).toBe(
      'Ran commands'
    );
  });

  it('keeps pending summaries active and failures inside the details', () => {
    const command = call('Bash', { command: 'git cherry-pick abc' });
    expect(getToolGroupLabel([{ ...command, status: 'error' }])).toBe('Ran git cherry-pick');
    expect(getToolGroupLabel([{ ...command, status: 'pending' }])).toBe('Running git cherry-pick');
    expect(getToolGroupLabel([command, { ...command, status: 'pending' }])).toBe(
      'Running commands'
    );
  });
});
