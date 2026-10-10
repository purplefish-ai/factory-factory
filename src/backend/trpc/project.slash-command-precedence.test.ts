import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRouter } from './project.trpc';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe('project slash command precedence', () => {
  let tempRoot: string;
  let homePath: string;
  let projectPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'project-slash-precedence-'));
    homePath = join(tempRoot, 'home');
    projectPath = join(tempRoot, 'project');
    mkdirSync(homePath);
    mkdirSync(projectPath);
    vi.mocked(homedir).mockReturnValue(homePath);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeCommand(root: string, name: string, description: string) {
    const commandsPath = join(root, '.claude', 'commands');
    mkdirSync(commandsPath, { recursive: true });
    writeFileSync(join(commandsPath, `${name}.md`), `---\ndescription: ${description}\n---\n`);
  }

  async function listCommands() {
    const caller = projectRouter.createCaller({
      appContext: {
        services: {
          projectManagementService: {
            findById: async () => ({ id: 'project-1', repoPath: projectPath }),
          },
        },
      },
    } as never);
    return (await caller.listSlashCommands({ projectId: 'project-1' })).commands;
  }

  it('uses the project description for collisions while preserving unique commands', async () => {
    writeCommand(homePath, 'review', 'Home review');
    writeCommand(projectPath, 'review', 'Project review');
    writeCommand(homePath, 'global-only', 'Global command');
    writeCommand(projectPath, 'project-only', 'Project command');

    const commands = await listCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        { name: 'review', description: 'Project review' },
        { name: 'global-only', description: 'Global command' },
        { name: 'project-only', description: 'Project command' },
      ])
    );
    expect(commands).toHaveLength(3);
  });

  it('still lists global commands when the project commands directory is absent', async () => {
    writeCommand(homePath, 'global-only', 'Global command');

    expect(await listCommands()).toEqual([{ name: 'global-only', description: 'Global command' }]);
  });

  it('does not let an escaped project command shadow a valid global command', async () => {
    writeCommand(homePath, 'review', 'Home review');
    const commandsPath = join(projectPath, '.claude', 'commands');
    mkdirSync(commandsPath, { recursive: true });
    const escapedPath = join(tempRoot, 'escaped.md');
    writeFileSync(escapedPath, '---\ndescription: Escaped review\n---\n');
    symlinkSync(escapedPath, join(commandsPath, 'review.md'));

    expect(await listCommands()).toEqual([{ name: 'review', description: 'Home review' }]);
  });
});
