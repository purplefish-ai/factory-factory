import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  checkPairing,
  checkRecords,
  checkReferences,
  checkSize,
  compareLegacyCeilings,
  formatGuidanceViolation,
  githubHeadingSlug,
  legacyNoteCeilings,
  markdownAnchors,
  parseLegacyNoteCeilings,
  readBaseLegacyCeilings,
  readGuidanceRepository,
  runGuidanceCli,
} from './check-guidance';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(repositoryRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function writeFiles(repositoryRoot: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repositoryRoot, path)), { recursive: true });
    writeFileSync(join(repositoryRoot, path), content);
  }
}

function createRepository(files: Record<string, string>): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'guidance-check-'));
  temporaryDirectories.push(repositoryRoot);
  git(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'test@example.com');
  git(repositoryRoot, 'config', 'user.name', 'Guidance Check Test');
  git(repositoryRoot, 'config', 'commit.gpgsign', 'false');
  writeFiles(repositoryRoot, files);
  return repositoryRoot;
}

function repositoryWith(files: Record<string, string>) {
  return readGuidanceRepository(createRepository(files));
}

function lines(count: number): string {
  return 'line\n'.repeat(count);
}

const pairedGuide = { 'src/area/AGENTS.md': '# Area\n', 'src/area/CLAUDE.md': '@AGENTS.md\n' };

describe('wiring', () => {
  test('runs as part of pnpm check', () => {
    const { scripts } = z
      .object({ scripts: z.object({ 'check:guidance': z.string(), check: z.string() }) })
      .parse(JSON.parse(readFileSync('package.json', 'utf8')));

    expect(scripts['check:guidance']).toBe('tsx scripts/check-guidance.ts');
    expect(scripts.check.split(' && ')).toContain('pnpm check:guidance');
  });

  test('gives the CI checks job the merge parents it compares ceilings against', () => {
    const workflow = z
      .object({
        jobs: z.object({
          checks: z.object({
            steps: z.array(
              z
                .object({ uses: z.string().optional(), with: z.record(z.string(), z.unknown()) })
                .partial()
            ),
          }),
        }),
      })
      .parse(parse(readFileSync('.github/workflows/ci.yml', 'utf8')));
    const checkout = workflow.jobs.checks.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@')
    );

    expect(checkout?.with?.['fetch-depth']).toBe(2);
  });

  test('reads its own legacy ceilings back from source, one entry per line', () => {
    const source = readFileSync('scripts/check-guidance.ts', 'utf8');

    expect(parseLegacyNoteCeilings(source)).toEqual(legacyNoteCeilings);
  });
});

describe('size', () => {
  const ceilings = { 'docs/architecture/legacy.md': 500 };

  test('accepts guides and notes within their limits and a legacy note at its ceiling', () => {
    const repository = repositoryWith({
      'AGENTS.md': lines(120),
      'docs/architecture/small.md': lines(400),
      'docs/architecture/legacy.md': lines(500),
      'docs/chat-message-flow.md': lines(400),
      'docs/other.md': lines(900),
    });

    expect(checkSize(repository, ceilings)).toEqual([]);
  });

  test('rejects an oversized guide, an oversized note and a legacy note above its ceiling', () => {
    const repository = repositoryWith({
      'src/area/AGENTS.md': lines(121),
      'docs/chat-message-flow.md': lines(401),
      'docs/architecture/legacy.md': lines(501),
    });

    expect(checkSize(repository, ceilings).map(formatGuidanceViolation)).toEqual([
      'docs/architecture/legacy.md: size: 501 lines exceeds its legacy ceiling of 500. Fix: bring it to 500 lines or fewer; put new guidance beside the code, not in this note.',
      'docs/chat-message-flow.md: size: 401 lines exceeds the 400-line limit for a note. Fix: move ownership and invariants into guides beside the code and reasons into decision records; do not add a legacy ceiling.',
      'src/area/AGENTS.md: size: 121 lines exceeds the 120-line limit for an AGENTS.md. Fix: move detail into a nearer AGENTS.md, a linked guide or a decision record.',
    ]);
  });

  test('a legacy note below its ceiling passes', () => {
    const repository = repositoryWith({
      'docs/architecture/shrunk.md': lines(450),
      'docs/architecture/settled.md': lines(390),
    });

    expect(
      checkSize(repository, {
        'docs/architecture/shrunk.md': 500,
        'docs/architecture/settled.md': 500,
      })
    ).toEqual([]);
  });

  test('a legacy note above its ceiling fails', () => {
    const repository = repositoryWith({ 'docs/architecture/legacy.md': lines(501) });

    expect(checkSize(repository, ceilings).map(formatGuidanceViolation)).toEqual([
      'docs/architecture/legacy.md: size: 501 lines exceeds its legacy ceiling of 500. Fix: bring it to 500 lines or fewer; put new guidance beside the code, not in this note.',
    ]);
  });

  test('a ceiling for a note that no longer exists fails', () => {
    const repository = repositoryWith({ 'docs/README.md': '# Docs\n' });

    expect(
      checkSize(repository, { 'docs/architecture/deleted.md': 500 }).map(formatGuidanceViolation)
    ).toEqual([
      'docs/architecture/deleted.md: size: has a legacy ceiling of 500 but no longer exists. Fix: remove its entry from legacyNoteCeilings in scripts/check-guidance.ts.',
    ]);
  });
});

describe('legacy ceilings against the base branch', () => {
  const base = { 'docs/architecture/a.md': 900, 'docs/architecture/b.md': 600 };

  test('lowering or removing a legacy ceiling passes', () => {
    expect(compareLegacyCeilings(base, { 'docs/architecture/a.md': 850 })).toEqual([]);
  });

  test('raising a legacy ceiling fails', () => {
    expect(
      compareLegacyCeilings(base, { ...base, 'docs/architecture/a.md': 901 }).map(
        formatGuidanceViolation
      )
    ).toEqual([
      'docs/architecture/a.md: size: legacy ceiling was raised from 900 to 901. Fix: restore the ceiling to 900 or lower and bring the note within it.',
    ]);
  });

  test('adding a legacy ceiling fails', () => {
    expect(
      compareLegacyCeilings(base, { ...base, 'docs/architecture/c.md': 450 }).map(
        formatGuidanceViolation
      )
    ).toEqual([
      'docs/architecture/c.md: size: legacy ceiling of 450 was added; the base branch has none. Fix: remove the entry and bring the note to 400 lines or fewer.',
    ]);
  });
});

describe('pairing', () => {
  test('accepts an AGENTS.md beside a CLAUDE.md that imports it', () => {
    expect(
      checkPairing(
        repositoryWith({ 'AGENTS.md': '# Root\n', 'CLAUDE.md': '@AGENTS.md', ...pairedGuide })
      )
    ).toEqual([]);
  });

  test('rejects a guide without its pair and a CLAUDE.md with its own guidance', () => {
    const repository = repositoryWith({
      'AGENTS.md': '# Root\n',
      'src/lonely/CLAUDE.md': '@AGENTS.md\n',
      'src/area/AGENTS.md': '# Area\n',
      'src/area/CLAUDE.md': '@AGENTS.md\nAlso remember this.\n',
    });

    expect(checkPairing(repository).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md: pairing: has no sibling CLAUDE.md. Fix: create CLAUDE.md containing exactly @AGENTS.md.',
      'src/area/CLAUDE.md: pairing: does not contain exactly @AGENTS.md. Fix: move its guidance into src/area/AGENTS.md and make this file contain exactly @AGENTS.md.',
      'src/lonely/CLAUDE.md: pairing: has no sibling AGENTS.md. Fix: move its guidance into src/lonely/AGENTS.md and make this file contain exactly @AGENTS.md.',
    ]);
  });
});

describe('references', () => {
  const targets = {
    'src/backend/thing.ts': 'export {};\n',
    'package.json': '{}\n',
    'docs/architecture/target.md':
      '# Target\n\n## Poll `cadence` (two minutes)\n\n## Poll cadence\n\n## Poll cadence\n',
  };

  test('accepts live links, anchors and paths, and ignores what names no current file', () => {
    const repository = repositoryWith({
      ...targets,
      'docs/README.md': [
        'See [the target](architecture/target.md#poll-cadence-two-minutes), its',
        '[second heading](architecture/target.md#poll-cadence-1), [the top](#guide) and',
        '[the directory](../src/backend/). The source is `src/backend/thing.ts:12`,',
        'configured in `package.json`; see [the site](https://example.com/missing.md).',
        '',
        '# Guide',
        '',
        'Globs and placeholders such as `src/**/*.ts`, `src/<name>/AGENTS.md`,',
        '`src/{a,b}.ts`, `src/.../x.ts` and the import `@/backend/missing` are not',
        'paths. Neither is `[a link](missing.md)` inside code.',
        '',
        '```md',
        '[fenced](missing.md) `src/fenced/missing.ts`',
        '```',
        '',
        '- [ ] Create `src/new/AGENTS.md` and `docs/decisions/2026-11-13-new.md`.',
        '',
      ].join('\n'),
      'docs/superpowers/plans/plan.md': 'Uses `src/removed.ts` and [gone](gone.md).\n',
      'docs/design/old.md': 'Uses `src/removed.ts`.\n',
    });

    expect(checkReferences(repository)).toEqual([]);
  });

  test('rejects a dead link, a dead anchor and a dead backticked path, with their lines', () => {
    const repository = repositoryWith({
      ...targets,
      ...pairedGuide,
      'docs/architecture/guide.md': [
        '# Guide',
        '',
        'Read [the old note](old-note.md) and [a heading](target.md#retired-heading).',
        'The service lived in',
        '`src/backend/removed.service.ts`, configured in `knip.json`.',
        '',
      ].join('\n'),
      'src/area/AGENTS.md': 'Run [the recipe](../../docs/recipes/run.md).\n',
    });

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      'docs/architecture/guide.md:5: references: `src/backend/removed.service.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:5: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:3: references: link `old-note.md` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:3: references: link `target.md#retired-heading` names a heading that does not exist in docs/architecture/target.md. Fix: point it at the current path or heading, or remove it.',
      'src/area/AGENTS.md:1: references: link `../../docs/recipes/run.md` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('finds setext headings and explicit anchors, and skips nested or CR-ended fences', () => {
    const repository = repositoryWith({
      'docs/architecture/setext.md': [
        'Overview',
        '========',
        '',
        'Intro text.',
        '',
        'Poll cadence',
        '------------',
        '',
        '- item',
        '---',
        '',
        '<a id="Mixed-Case"></a>',
        '',
      ].join('\n'),
      'docs/README.md': [
        'See [the overview](architecture/setext.md#overview),',
        '[the cadence](architecture/setext.md#poll-cadence) and',
        '[the explicit anchor](architecture/setext.md#Mixed-Case).',
        '',
        '1. Step one',
        '',
        '    ~~~sh',
        '    echo "[fenced](missing.md)"',
        '    ~~~',
        '',
      ].join('\n'),
      'docs/workspaces.md': 'Text before.\r~~~\r`src/cr/missing.ts`\r~~~\r',
    });

    expect(markdownAnchors(repository.read('docs/architecture/setext.md'))).toEqual(
      new Set(['overview', 'poll-cadence', 'Mixed-Case'])
    );
    expect(checkReferences(repository)).toEqual([]);
  });

  test('slugs headings the way GitHub does', () => {
    expect(githubHeadingSlug('Poll `cadence` (two minutes)')).toBe('poll-cadence-two-minutes');
    expect(githubHeadingSlug('[Linked](x.md) A/B & C_d')).toBe('linked-ab--c_d');
    expect(githubHeadingSlug('<em>Install</em> when a < b')).toBe('install-when-a--b');
  });
});

describe('records', () => {
  test('accepts dated records within the limit, and no records directory at all', () => {
    expect(
      checkRecords(repositoryWith({ 'docs/decisions/2026-11-13-guidance-check.md': lines(80) }))
    ).toEqual([]);
    expect(checkRecords(repositoryWith({ 'docs/README.md': '# Docs\n' }))).toEqual([]);
  });

  test('rejects an undated name and a record over the limit', () => {
    const repository = repositoryWith({
      'docs/decisions/guidance-check.md': lines(10),
      'docs/decisions/2026-11-13-long-record.md': lines(81),
    });

    expect(checkRecords(repository).map(formatGuidanceViolation)).toEqual([
      'docs/decisions/2026-11-13-long-record.md: records: 81 lines exceeds the 80-line limit for a decision record. Fix: record one decision and its reasons; move how-to detail into a guide beside the code.',
      'docs/decisions/guidance-check.md: records: is not named YYYY-MM-DD-slug.md. Fix: rename it to the decision date and a lowercase hyphenated slug, such as 2026-11-13-guidance-check.md.',
    ]);
  });
});

describe('base ceilings from Git', () => {
  function scriptWithCeilings(ceilings: Record<string, number>): string {
    const entries = Object.entries(ceilings).map(([path, lines]) => `  '${path}': ${lines},\n`);
    return `export const legacyNoteCeilings: LegacyNoteCeilings = {\n${entries.join('')}};\n`;
  }

  function commitAll(repositoryRoot: string, message: string): string {
    git(repositoryRoot, 'add', '-A');
    git(repositoryRoot, 'commit', '--quiet', '-m', message);
    return git(repositoryRoot, 'rev-parse', 'HEAD');
  }

  test('passes with a notice when no base can be resolved', () => {
    const repositoryRoot = createRepository({ 'README.md': '# Fixture\n' });
    commitAll(repositoryRoot, 'initial');

    expect(readBaseLegacyCeilings(repositoryRoot)).toEqual({
      notice:
        'no base ref (merge base with origin/main or a merge parent); legacy ceilings were not compared with the base branch.',
    });
  });

  test('passes with a notice when the base predates the check', () => {
    const repositoryRoot = createRepository({ 'README.md': '# Fixture\n' });
    const base = commitAll(repositoryRoot, 'initial');
    git(repositoryRoot, 'update-ref', 'refs/remotes/origin/main', base);

    expect(readBaseLegacyCeilings(repositoryRoot)).toEqual({
      notice: `scripts/check-guidance.ts does not exist at ${base.slice(0, 12)}; legacy ceilings were not compared with the base branch.`,
    });
  });

  test('reads the ceilings at the merge base with origin/main', () => {
    const repositoryRoot = createRepository({
      'scripts/check-guidance.ts': scriptWithCeilings({ 'docs/architecture/a.md': 900 }),
    });
    const base = commitAll(repositoryRoot, 'base');
    git(repositoryRoot, 'update-ref', 'refs/remotes/origin/main', base);
    writeFiles(repositoryRoot, {
      'scripts/check-guidance.ts': scriptWithCeilings({ 'docs/architecture/a.md': 950 }),
    });
    commitAll(repositoryRoot, 'raise');

    expect(readBaseLegacyCeilings(repositoryRoot)).toEqual({
      ref: base,
      ceilings: { 'docs/architecture/a.md': 900 },
    });
  });

  test('reads the ceilings at the first parent of a pull request merge commit', () => {
    const repositoryRoot = createRepository({
      'scripts/check-guidance.ts': scriptWithCeilings({ 'docs/architecture/a.md': 900 }),
    });
    commitAll(repositoryRoot, 'base');
    git(repositoryRoot, 'switch', '--quiet', '-c', 'feature');
    writeFiles(repositoryRoot, {
      'scripts/check-guidance.ts': scriptWithCeilings({ 'docs/architecture/a.md': 950 }),
    });
    commitAll(repositoryRoot, 'raise');
    git(repositoryRoot, 'switch', '--quiet', 'main');
    writeFiles(repositoryRoot, {
      'scripts/check-guidance.ts': scriptWithCeilings({ 'docs/architecture/a.md': 800 }),
    });
    const mainTip = commitAll(repositoryRoot, 'lower on main');
    git(repositoryRoot, 'merge', '--quiet', '--no-ff', '-X', 'theirs', '-m', 'merge', 'feature');

    expect(readBaseLegacyCeilings(repositoryRoot)).toEqual({
      ref: mainTip,
      ceilings: { 'docs/architecture/a.md': 800 },
    });
  });
});

describe('command line', () => {
  function run(repositoryRoot: string, baseCeilings: Parameters<typeof runGuidanceCli>[0]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = runGuidanceCli({
      repositoryRoot,
      ceilings: {},
      ...baseCeilings,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  test('passes a clean repository and prints the notice for a missing base', () => {
    const repositoryRoot = createRepository({
      'AGENTS.md': '# Root\n',
      'CLAUDE.md': '@AGENTS.md\n',
    });

    expect(run(repositoryRoot, { baseCeilings: { notice: 'no base.' } })).toEqual({
      exitCode: 0,
      stdout: 'Guidance check: no base.\nGuidance check passed.\n',
      stderr: '',
    });
  });

  test('prints one line per failure with the file, the rule and the fix', () => {
    const repositoryRoot = createRepository({
      'AGENTS.md': `${lines(121)}\`src/missing.ts\`\n`,
      'docs/architecture/legacy.md': lines(450),
    });

    const result = run(repositoryRoot, {
      ceilings: { 'docs/architecture/legacy.md': 450 },
      baseCeilings: { ref: 'base', ceilings: {} },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trimEnd().split('\n')).toEqual([
      'AGENTS.md: size: 122 lines exceeds the 120-line limit for an AGENTS.md. Fix: move detail into a nearer AGENTS.md, a linked guide or a decision record.',
      'docs/architecture/legacy.md: size: legacy ceiling of 450 was added; the base branch has none. Fix: remove the entry and bring the note to 400 lines or fewer.',
      'AGENTS.md: pairing: has no sibling CLAUDE.md. Fix: create CLAUDE.md containing exactly @AGENTS.md.',
      'AGENTS.md:122: references: `src/missing.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });
});
