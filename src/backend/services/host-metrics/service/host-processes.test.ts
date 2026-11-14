import { describe, expect, it } from 'vitest';
import {
  groupHostProcesses,
  type HostProcess,
  type ProcessOwner,
  parsePsOutput,
} from './host-processes';

const proc = (
  pid: number,
  ppid: number,
  cpuPercent: number,
  command: string,
  memoryBytes = 1024
): HostProcess => ({ pid, ppid, cpuPercent, memoryBytes, command });

const workspaceOwner: ProcessOwner = {
  key: 'workspace:w1',
  label: 'Fix login',
  kind: 'workspace',
  workspace: { id: 'w1', projectSlug: 'repo' },
};
const factoryOwner: ProcessOwner = {
  key: 'factory-factory',
  label: 'Factory Factory',
  kind: 'factory',
  workspace: null,
};

describe('parsePsOutput', () => {
  it('reads pid, parent, CPU, RSS in kilobytes and a command with spaces', () => {
    const stdout = [
      '    1     0   0.3  13456 /sbin/launchd',
      '  812     1  41.5 204800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'not a process line',
      '',
    ].join('\n');

    expect(parsePsOutput(stdout)).toEqual([
      { pid: 1, ppid: 0, cpuPercent: 0.3, memoryBytes: 13_456 * 1024, command: '/sbin/launchd' },
      {
        pid: 812,
        ppid: 1,
        cpuPercent: 41.5,
        memoryBytes: 204_800 * 1024,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    ]);
  });
});

describe('groupHostProcesses', () => {
  it('counts every helper of a macOS app as the outermost app', () => {
    const groups = groupHostProcesses(
      [
        proc(10, 1, 20, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        proc(
          11,
          10,
          60,
          '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'
        ),
      ],
      new Map(),
      4
    );

    expect(groups).toEqual([
      expect.objectContaining({ label: 'Google Chrome', kind: 'app', processCount: 2 }),
    ]);
  });

  it('reports CPU as a share of the whole machine', () => {
    const [group] = groupHostProcesses([proc(10, 1, 200, '/usr/bin/yes')], new Map(), 8);

    expect(group).toMatchObject({ label: 'yes', kind: 'process', cpuPercent: 25 });
  });

  it('gives a process to its nearest owned ancestor, not the server above it', () => {
    const owners = new Map([
      [100, factoryOwner],
      [200, workspaceOwner],
    ]);
    const groups = groupHostProcesses(
      [
        proc(100, 1, 4, '/usr/local/bin/node'),
        proc(150, 100, 4, '/usr/local/bin/git'),
        proc(200, 100, 4, '/usr/local/bin/claude'),
        proc(300, 200, 4, '/bin/zsh'),
        proc(400, 300, 80, '/usr/local/bin/node'),
      ],
      owners,
      1
    );

    expect(
      groups.map(({ label, processCount, cpuPercent }) => [label, processCount, cpuPercent])
    ).toEqual([
      ['Fix login', 3, 88],
      ['Factory Factory', 2, 8],
    ]);
    expect(groups[0]?.workspace).toEqual({ id: 'w1', projectSlug: 'repo' });
  });

  it('survives a parent loop from a pid reused mid-read', () => {
    const groups = groupHostProcesses(
      [proc(5, 6, 1, '/bin/a'), proc(6, 5, 1, '/bin/b')],
      new Map(),
      1
    );

    expect(groups).toHaveLength(2);
  });
});
