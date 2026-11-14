import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Command,
  collectCiAttempts,
  collectCommitFiles,
  collectKeywordInstructionAt,
  collectTree,
} from './collect';

const commit = '0123456789abcdef0123456789abcdef01234567';

function runListRow(databaseId: number, attempt: number, headBranch: string) {
  return {
    databaseId,
    attempt,
    headBranch,
    headSha: `sha-${databaseId}`,
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-11-01T10:30:00Z',
    updatedAt: '2026-11-01T10:35:00Z',
  };
}

function runAttempt(id: number, attempt: number) {
  return {
    id,
    run_attempt: attempt,
    head_branch: null,
    head_sha: `sha-${id}`,
    status: 'completed',
    conclusion: 'failure',
    run_started_at: `2026-11-01T10:0${attempt}:00Z`,
    updated_at: `2026-11-01T10:0${attempt}:30Z`,
  };
}

/** Records every call and answers from `responses`, keyed by the joined arguments. */
function fakeCommand(responses: Record<string, string | Buffer>) {
  const calls: string[] = [];
  const command: Command = (args) => {
    const key = args.join(' ');
    calls.push(key);
    const response = responses[key];
    if (response === undefined) {
      throw new Error(`Unexpected command: ${key}`);
    }
    return Buffer.from(response);
  };
  return { command, calls };
}

// Commits as `git log --name-only` reports them, newest first. The second has no files.
const loggedCommits = [['src/a b.ts', 'src/ü.ts'], [], ['README.md']];

function quotePath(path: string): string {
  if (/^[ -~]*$/.test(path)) {
    return path;
  }
  const octal = [...Buffer.from(path)].map((byte) =>
    byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8)}`
  );
  return `"${octal.join('')}"`;
}

/** What `git log --format=<format> --name-only --no-renames` prints, with or without `-z`. */
function gitLogOutput(args: readonly string[]): string {
  const nulTerminated = args.includes('-z');
  const format = args.find((arg) => arg.startsWith('--format='))?.slice('--format='.length) ?? '';
  return loggedCommits
    .map((files, index) => {
      const header = format.replaceAll('%x1e', '\u001e').replaceAll('%H', String(index).repeat(40));
      return nulTerminated
        ? `${header}\0${files.length > 0 ? `\n${files.map((file) => `${file}\0`).join('')}` : ''}`
        : `${header}\n${files.length > 0 ? `\n${files.map((file) => `${quotePath(file)}\n`).join('')}` : ''}`;
    })
    .join('');
}

/** A `git` that answers the commands `collectTree` and `collectCommitFiles` run against `files`. */
function fakeGit(files: Record<string, string>): Command {
  const objectId = (content: string) => createHash('sha1').update(content).digest('hex');
  const byObjectId = new Map(Object.values(files).map((content) => [objectId(content), content]));
  return (args, input) => {
    const [subcommand] = args;
    if (subcommand === 'rev-parse') {
      return Buffer.from(`${commit}\n`);
    }
    if (subcommand === 'log') {
      return Buffer.from(gitLogOutput(args));
    }
    if (subcommand === 'ls-files') {
      return Buffer.from(
        Object.keys(files)
          .map((path) => `${path}\0`)
          .join('')
      );
    }
    if (subcommand === 'ls-tree' && args.includes(commit)) {
      return Buffer.from(
        Object.entries(files)
          .map(([path, content]) => `100644 blob ${objectId(content)}\t${path}\0`)
          .join('')
      );
    }
    if (subcommand === 'cat-file' && args.includes('--batch') && input !== undefined) {
      return Buffer.concat(
        input
          .split('\n')
          .filter((line) => line.length > 0)
          .flatMap((id) => {
            const content = Buffer.from(byObjectId.get(id) ?? '');
            return [Buffer.from(`${id} blob ${content.length}\n`), content, Buffer.from('\n')];
          })
      );
    }
    throw new Error(`Unexpected command: git ${args.join(' ')}`);
  };
}

describe('collectCiAttempts', () => {
  it('fetches every earlier attempt of a re-run, keeping the run branch', () => {
    const gh = fakeCommand({
      'run list --workflow ci.yml --event pull_request --limit 10 --json attempt,conclusion,databaseId,headBranch,headSha,startedAt,status,updatedAt':
        JSON.stringify([runListRow(7, 3, 'rerun-branch'), runListRow(8, 1, 'single')]),
      'api repos/{owner}/{repo}/actions/runs/7/attempts/1': JSON.stringify(runAttempt(7, 1)),
      'api repos/{owner}/{repo}/actions/runs/7/attempts/2': JSON.stringify(runAttempt(7, 2)),
    });
    const attempts = collectCiAttempts('/repo', 10, gh.command);
    expect(gh.calls.filter((call) => call.startsWith('api '))).toEqual([
      'api repos/{owner}/{repo}/actions/runs/7/attempts/1',
      'api repos/{owner}/{repo}/actions/runs/7/attempts/2',
    ]);
    expect(
      attempts.map(({ runId, attempt, branch, conclusion }) => [runId, attempt, branch, conclusion])
    ).toEqual([
      [7, 3, 'rerun-branch', 'success'],
      [8, 1, 'single', 'success'],
      [7, 1, 'rerun-branch', 'failure'],
      [7, 2, 'rerun-branch', 'failure'],
    ]);
  });
});

describe('collectCommitFiles', () => {
  it('reads paths with spaces and non-ASCII characters unquoted', () => {
    expect(collectCommitFiles('/repo', 3, fakeGit({}))).toEqual(loggedCommits);
  });
});

describe('collectKeywordInstructionAt', () => {
  it('asks git for the oldest commit that added the instruction to the template', () => {
    const git = fakeCommand({
      [`log --reverse --format=%cI -SDoes not apply: ${commit} -- .github/pull_request_template.md`]:
        '2026-11-14T08:30:00-05:00\n2026-11-16T09:00:00+01:00\n',
    });
    expect(collectKeywordInstructionAt(git.command, commit)).toBe('2026-11-14T13:30:00Z');
    expect(git.calls).toHaveLength(1);
  });

  it('fails, rather than judge every pull request, when no commit added the instruction', () => {
    const git = fakeCommand({
      [`log --reverse --format=%cI -SDoes not apply: ${commit} -- .github/pull_request_template.md`]:
        '\n',
    });
    expect(() => collectKeywordInstructionAt(git.command, commit)).toThrow(
      'has no commit adding "Does not apply:"'
    );
  });

  describe('against a real repository', () => {
    let repository: string | undefined;

    afterEach(() => {
      if (repository) {
        rmSync(repository, { recursive: true, force: true });
      }
    });

    function commitTemplate(git: Command, directory: string, content: string, date: string) {
      writeFileSync(join(directory, '.github/pull_request_template.md'), content);
      git(['add', '.']);
      // The commit date, which the script reads, is the committer date.
      execFileSync('git', ['commit', '-q', '-m', 'template', '--date', date], {
        cwd: directory,
        env: { ...process.env, GIT_COMMITTER_DATE: date },
      });
    }

    it('finds the first commit that added the instruction, not a later edit or removal', () => {
      repository = mkdtempSync(join(tmpdir(), 'agent-metrics-git-'));
      const directory = repository;
      const git: Command = (args) => execFileSync('git', args, { cwd: directory });
      git(['init', '-q']);
      git(['config', 'user.name', 'Test']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'commit.gpgsign', 'false']);
      mkdirSync(join(directory, '.github'));
      commitTemplate(git, directory, '## Why\n', '2026-11-10T10:00:00+00:00');
      commitTemplate(git, directory, '## Why\n\n<!-- Evidence. -->\n', '2026-11-12T10:00:00+00:00');
      commitTemplate(
        git,
        directory,
        '## Why\n\n<!-- Begin with "Driven:" or "Does not apply:" -->\n',
        '2026-11-14T10:00:00+02:00'
      );
      commitTemplate(git, directory, '## Why\n\n<!-- Reworded. -->\n', '2026-11-15T10:00:00+00:00');
      commitTemplate(
        git,
        directory,
        '## Why\n\n<!-- Does not apply: again. -->\n',
        '2026-11-16T10:00:00+00:00'
      );
      expect(collectKeywordInstructionAt(git, 'HEAD')).toBe('2026-11-14T08:00:00Z');
    });
  });
});

describe('collectTree', () => {
  let workingTree: string | undefined;

  afterEach(() => {
    if (workingTree) {
      rmSync(workingTree, { recursive: true, force: true });
    }
  });

  it('measures the commit it names, not a dirty working tree', () => {
    const lines = (count: number) => 'const x = 1;\n'.repeat(count);
    const committed = {
      'AGENTS.md': 'Guide.\n',
      'docs/architecture/note.md': 'One.\nTwo.\n',
      'src/big.ts': lines(900),
      'src/deleted-in-working-tree.ts': lines(950),
      'src/a.test.ts': "vi.mock('node:fs');\n",
      'scripts/unused-code-baseline.json': '{"version":1,"production":{},"exports":{}}',
      'scripts/file-length-baseline.json': '{}',
    };
    workingTree = mkdtempSync(join(tmpdir(), 'agent-metrics-'));
    const dirty = Object.entries({
      ...committed,
      'src/big.ts': lines(3),
      'src/a.test.ts': "it('runs', () => {});\n",
    }).filter(([path]) => path !== 'src/deleted-in-working-tree.ts');
    for (const [path, content] of dirty) {
      mkdirSync(dirname(join(workingTree, path)), { recursive: true });
      writeFileSync(join(workingTree, path), content);
    }

    const tree = collectTree(workingTree, fakeGit(committed));
    expect(tree).toMatchObject({
      commit,
      guidance: { guideLines: 1, architectureNoteLines: 2, sourceLines: 1850 },
      largeProductionFiles: {
        count: 2,
        files: [
          { path: 'src/deleted-in-working-tree.ts', lines: 950 },
          { path: 'src/big.ts', lines: 900 },
        ],
      },
      viMocks: { calls: 1, filesWithMocks: 1, testFiles: 1 },
      sessionModuleCycles: null,
    });
  });
});

describe('lint rule exceptions', () => {
  const baseTree = {
    'scripts/unused-code-baseline.json': '{"version":1,"production":{},"exports":{}}',
    'scripts/file-length-baseline.json': '{}',
    '.oxlintrc.json': '{"rules":{"a":["error",{"exceptions":{"x.ts":"reason"}}]}}',
  };
  const exceptions = (count: number) =>
    JSON.stringify(
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`src/${index}.ts`, 'Why.']))
    );

  it('counts the entries of every lint-rules/rules/*.exceptions.json in the commit', () => {
    const tree = collectTree(
      '/repo',
      fakeGit({
        ...baseTree,
        'lint-rules/rules/no-raw-spinner.exceptions.json': exceptions(3),
        'lint-rules/rules/a-new-rule.exceptions.json': exceptions(2),
        'lint-rules/rules/no-raw-spinner.options.json': exceptions(4),
        'lint-rules/rules/no-raw-spinner.mjs': 'export default {};\n',
      })
    );
    expect(tree.baselines.lintRuleExceptions).toBe(5);
  });

  it('counts none when there are no exceptions files', () => {
    expect(collectTree('/repo', fakeGit(baseTree)).baselines.lintRuleExceptions).toBe(0);
  });

  it('fails with the name of an exceptions file that is not a path-to-reason record', () => {
    expect(() =>
      collectTree(
        '/repo',
        fakeGit({
          ...baseTree,
          'lint-rules/rules/ok.exceptions.json': exceptions(1),
          'lint-rules/rules/broken.exceptions.json': '{"src/a.ts":["not","a reason"]}',
        })
      )
    ).toThrow('lint-rules/rules/broken.exceptions.json');
  });
});
