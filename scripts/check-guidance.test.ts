import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { countPhysicalLines } from './check-file-length';
import {
  checkPairing,
  checkRecipes,
  checkRecords,
  checkReferences,
  checkSize,
  classifyCodeSpan,
  compareLegacyCeilings,
  formatGuidanceViolation,
  githubHeadingSlug,
  guideReferenceExists,
  legacyNoteCeilings,
  markdownAnchors,
  parseLegacyNoteCeilings,
  parseTopLevelTree,
  readBaseLegacyCeilings,
  readBaseTopLevelNames,
  readGuidanceRepository,
  runGuidanceCli,
  topLevelNames,
  unionTopLevelNames,
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

const modes = { blob: '100644', tree: '040000', commit: '160000' };

/** The top-level names of a base tree, as `git ls-tree -z` prints them. */
function baseTopLevel(entries: Record<string, 'blob' | 'tree' | 'commit'>) {
  return parseTopLevelTree(
    Object.entries(entries)
      .map(([name, type]) => `${modes[type]} ${type} 0123abc\t${name}\0`)
      .join('')
  );
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

    // `knip.json` is deleted: the base ref has it, the working tree does not.
    const base = baseTopLevel({ 'knip.json': 'blob' });

    expect(checkReferences(repository, base).map(formatGuidanceViolation)).toEqual([
      'docs/architecture/guide.md:3: references: link `old-note.md` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:3: references: link `target.md#retired-heading` names a heading that does not exist in docs/architecture/target.md. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:5: references: `src/backend/removed.service.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/guide.md:5: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.',
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

describe('file names cited in a nested guide', () => {
  const tree = {
    'src/area/CLAUDE.md': '@AGENTS.md\n',
    'src/area/service.ts': 'export {};\n',
    'src/area/service.test.ts': 'export {};\n',
    'src/area/deep/helper.test.ts': 'export {};\n',
    'src/area/README.md': '# Area\n',
    'src/other/elsewhere.test.ts': 'export {};\n',
    'src/shared.ts': 'export {};\n',
    'package.json': '{}\n',
  };
  const guide = (...lines: string[]) => ({
    ...tree,
    'src/area/AGENTS.md': `${lines.join('\n')}\n`,
  });

  test('accepts a bare name in the directory or below, and relative paths that exist', () => {
    const repository = repositoryWith(
      guide(
        'Pinned by `service.test.ts`, `helper.test.ts` (in `deep/`), `deep/helper.test.ts`,',
        '`./service.ts`, `../shared.ts`, `../other/elsewhere.test.ts:12` and `service.ts#L3`.',
        'The siblings are `AGENTS.md`, `CLAUDE.md` and `README.md`; `package.json` is the root.'
      )
    );

    expect(checkReferences(repository)).toEqual([]);
  });

  test('rejects a name that is not in the directory or below, and a path that does not exist', () => {
    const repository = repositoryWith(
      guide(
        'Not here: `elsewhere.test.ts`, `shared.ts`, `service.test.tsx` and',
        '`missing/service.ts`. Not a path: `deep/service.ts`, `../missing.ts`, `./deep.ts`.',
        'Cited as `renamed.test.ts:4`.'
      )
    );

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      'src/area/AGENTS.md:1: references: `elsewhere.test.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:1: references: `shared.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:1: references: `service.test.tsx` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:2: references: `missing/service.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:2: references: `deep/service.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:2: references: `../missing.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:2: references: `./deep.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
      'src/area/AGENTS.md:3: references: `renamed.test.ts` is not under src/area. Fix: correct the name, or write the path from the repository root.',
    ]);
  });

  test('ignores prose, patterns, commands, packages and root-relative paths that exist', () => {
    const repository = repositoryWith(
      guide(
        'Properties such as `ref.current`, `config.service` and `Node.js`, the patterns `*.test.ts`,',
        '`.test.ts` and `.ts`, the placeholders `<name>.ts`, `{a,b}.ts` and `deep/**/x.ts`,',
        'the packages `@scope/pkg.json` and `node:fs`, the flag `-rf.sh`, the command',
        '`pnpm exec vitest run missing.test.ts`, the URL `https://example.com/missing.md`,',
        'the absolute paths `/etc/missing.sh` and `~/missing.json`, and the root path',
        '`src/shared.ts`.'
      )
    );

    expect(checkReferences(repository)).toEqual([]);
  });

  test('leaves the root guide and other documents to the root-relative rule', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': 'Mentions `service.ts`, `missing.test.ts` and `README.md`.\n',
      'docs/architecture/note.md': 'Mentions `service.ts` and `missing.test.ts`.\n',
    });

    expect(checkReferences(repository)).toEqual([]);
  });

  test('resolves a bare name against the directory and below, a path exactly', () => {
    const repository = repositoryWith(tree);

    expect(guideReferenceExists(repository, 'src/area', 'helper.test.ts')).toBe(true);
    expect(guideReferenceExists(repository, 'src/area', 'deep/helper.test.ts')).toBe(true);
    expect(guideReferenceExists(repository, 'src/area', '../shared.ts')).toBe(true);
    expect(guideReferenceExists(repository, 'src/area', 'shared.ts')).toBe(false);
    expect(guideReferenceExists(repository, 'src/area', '../../../x.ts')).toBe(false);
    expect(guideReferenceExists(repository, 'src/are', 'service.ts')).toBe(false);
  });
});

describe('top-level names come from the repository', () => {
  const tree = {
    'prompts/system.md': '# System\n',
    'bin/ff': '#!/bin/sh\n',
    'public/logo.svg': '<svg/>\n',
    'patches/fix.patch': 'x\n',
    '.storybook/main.ts': 'export {};\n',
    '.husky/pre-commit': 'pnpm check\n',
    'factory-factory.json': '{}\n',
    'README.md': '# Root\n',
    'docs/README.md': '# Docs\n',
    'src/backend/thing.ts': 'export {};\n',
    ...pairedGuide,
  };

  test('accepts paths under any top-level directory and any root file that exists', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': [
        'See `prompts/system.md`, `bin/ff`, `public/logo.svg`, `patches/fix.patch`,',
        '`.storybook/main.ts`, `.husky/pre-commit`, `factory-factory.json`,',
        '`src/`, `src/backend/` and `docs/README.md`.',
        'Without a path, `prompts`, `public` and `patches` are just words.',
        '',
      ].join('\n'),
    });

    expect(checkReferences(repository)).toEqual([]);
  });

  test('rejects paths under a top-level directory that name nothing, and directories as files', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': [
        'See `prompts/missing.md`, `.storybook/missing.ts`, `public/gone/`,',
        '`src/backend`, `src/backend/thing.ts/` and `docs/architecture/`.',
        '',
      ].join('\n'),
    });

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md:1: references: `prompts/missing.md` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:1: references: `.storybook/missing.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:1: references: `public/gone/` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:2: references: `src/backend` is a directory. Fix: write it with a trailing slash, `src/backend/`.',
      'AGENTS.md:2: references: `src/backend/thing.ts/` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:2: references: `docs/architecture/` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('in a nested guide, AGENTS.md, CLAUDE.md and README.md name a sibling, not the root file', () => {
    const repository = repositoryWith({
      ...tree,
      'src/area/AGENTS.md': 'Siblings: `AGENTS.md`, `CLAUDE.md` and `README.md`.\n',
    });

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      'src/area/AGENTS.md:1: references: `README.md` is not under src/area. Fix: correct the name, or write the path from the repository root.',
    ]);
  });

  test('derives the first path segments of the tracked files', () => {
    expect(
      topLevelNames(['.husky/pre-commit', 'README.md', 'src/a/b.ts', 'src/c.ts', 'bin/ff'])
    ).toEqual({
      directories: new Set(['.husky', 'src', 'bin']),
      files: new Set(['README.md']),
    });
  });

  test('classifies spans as root paths, guide paths or neither', () => {
    const top = topLevelNames(['src/a.ts', 'package.json', 'AGENTS.md', 'prompts/a.md']);

    expect(classifyCodeSpan('src/a.ts:12', top)).toEqual({ from: 'root', path: 'src/a.ts' });
    expect(classifyCodeSpan('./src/a.ts', top)).toEqual({ from: 'root', path: 'src/a.ts' });
    expect(classifyCodeSpan('prompts/', top, 'src/area')).toEqual({
      from: 'root',
      path: 'prompts/',
    });
    expect(classifyCodeSpan('package.json', top, 'src/area')).toEqual({
      from: 'root',
      path: 'package.json',
    });
    expect(classifyCodeSpan('AGENTS.md', top, 'src/area')).toEqual({
      from: 'guide',
      path: 'AGENTS.md',
    });
    expect(classifyCodeSpan('AGENTS.md', top)).toBeUndefined();
    expect(classifyCodeSpan('../a.ts', top, 'src/area')).toEqual({
      from: 'guide',
      path: '../a.ts',
    });
    expect(classifyCodeSpan('./a.ts', top, 'src/area')).toEqual({ from: 'guide', path: './a.ts' });
    expect(classifyCodeSpan('a.ts', top)).toBeUndefined();
    expect(classifyCodeSpan('src', top, 'src/area')).toBeUndefined();
    expect(classifyCodeSpan('src/../x.ts', top, 'src/area')).toBeUndefined();
  });
});

describe('names that exist only at the base ref', () => {
  const tree = {
    'src/backend/thing.ts': 'export {};\n',
    'package.json': '{}\n',
    ...pairedGuide,
  };
  const base = baseTopLevel({
    '.oxlintrc.json': 'blob',
    'knip.json': 'blob',
    'package.json': 'blob',
    electron: 'tree',
    src: 'tree',
  });

  test('flags a root file deleted since the base ref, wherever it is cited', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': 'Configured in `knip.json`.\n',
      'docs/architecture/note.md': 'Configured in `knip.json`.\n',
      'src/area/AGENTS.md': 'Configured in `knip.json`.\n',
    });

    expect(checkReferences(repository, base).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md:1: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.',
      'docs/architecture/note.md:1: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.',
      'src/area/AGENTS.md:1: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('flags a top-level directory deleted since the base ref', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': 'The shell lives in `electron/main.ts` and `electron/`.\n',
    });

    expect(checkReferences(repository, base).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md:1: references: `electron/main.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:1: references: `electron/` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('flags a deleted dotfile in a nested guide before the hidden-name exclusion applies', () => {
    const repository = repositoryWith({
      ...tree,
      'src/area/AGENTS.md': 'Rules are in `.oxlintrc.json`, not `.eslintrc.json`.\n',
    });

    expect(checkReferences(repository, base).map(formatGuidanceViolation)).toEqual([
      'src/area/AGENTS.md:1: references: `.oxlintrc.json` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('without a base ref, the same citations pass', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': 'Configured in `knip.json`; the shell is `electron/main.ts`.\n',
      'src/area/AGENTS.md': 'Rules are in `.oxlintrc.json`.\n',
    });

    expect(checkReferences(repository)).toEqual([]);
  });

  test('names present in both the base and the working tree are checked as before', () => {
    const repository = repositoryWith({
      ...tree,
      'AGENTS.md': 'See `package.json`, `src/backend/thing.ts` and `src/backend/gone.ts`.\n',
    });

    expect(checkReferences(repository, base).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md:1: references: `src/backend/gone.ts` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });

  test('unions the working tree names with the base names', () => {
    expect(
      unionTopLevelNames(
        topLevelNames(['src/a.ts', 'package.json']),
        baseTopLevel({ src: 'tree', electron: 'tree', 'knip.json': 'blob', vendor: 'commit' })
      )
    ).toEqual({
      directories: new Set(['src', 'electron', 'vendor']),
      files: new Set(['package.json', 'knip.json']),
    });
  });

  test('reads the root level of the base ref from Git', () => {
    const repositoryRoot = createRepository({
      'knip.json': '{}\n',
      'electron/main.ts': 'export {};\n',
      'docs/README.md': '# Docs\n',
    });
    git(repositoryRoot, 'add', '-A');
    git(repositoryRoot, 'commit', '--quiet', '-m', 'base');

    expect(readBaseTopLevelNames(repositoryRoot, 'HEAD')).toEqual({
      directories: new Set(['electron', 'docs']),
      files: new Set(['knip.json']),
    });
    expect(readBaseTopLevelNames(repositoryRoot, 'no-such-ref')).toBeUndefined();
  });

  test('the command line uses the base ref, and falls back without one', () => {
    const repositoryRoot = createRepository({
      'knip.json': '{}\n',
      'docs/architecture/note.md': 'Configured in `knip.json`.\n',
    });
    git(repositoryRoot, 'add', '-A');
    git(repositoryRoot, 'commit', '--quiet', '-m', 'base');
    const baseRef = git(repositoryRoot, 'rev-parse', 'HEAD');
    rmSync(join(repositoryRoot, 'knip.json'));
    const run = (ref: string | undefined) => {
      const stderr: string[] = [];
      const exitCode = runGuidanceCli({
        repositoryRoot,
        ceilings: {},
        baseCeilings: ref === undefined ? { notice: 'no base.' } : { ref, ceilings: {} },
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      });
      return { exitCode, stderr: stderr.join('') };
    };

    expect(run(baseRef)).toEqual({
      exitCode: 1,
      stderr:
        'docs/architecture/note.md:1: references: `knip.json` does not exist. Fix: point it at the current path or heading, or remove it.\n',
    });
    expect(run(undefined)).toEqual({ exitCode: 0, stderr: '' });
  });
});

describe('no line is exempt', () => {
  test('rejects a dead path on a line that begins with Create', () => {
    const repository = repositoryWith({
      'AGENTS.md': '- [ ] Create `src/new/AGENTS.md` and `docs/decisions/2026-11-13-new.md`.\n',
      'src/existing.ts': 'export {};\n',
      'docs/existing.md': '# Existing\n',
    });

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      'AGENTS.md:1: references: `src/new/AGENTS.md` does not exist. Fix: point it at the current path or heading, or remove it.',
      'AGENTS.md:1: references: `docs/decisions/2026-11-13-new.md` does not exist. Fix: point it at the current path or heading, or remove it.',
    ]);
  });
});

describe('recipes', () => {
  const recipe = (extraLines = 0) =>
    [
      '# Add a thing',
      '',
      '## Use when',
      '',
      'You add a thing.',
      '',
      '## Steps',
      '',
      '1. Run `pnpm check`; it passes.',
      '',
      '```sh',
      '# a comment in a fence is not a heading',
      '```',
      '',
      '## Mistakes this prevents',
      '',
      '- A mistake.',
      lines(extraLines),
    ].join('\n');
  const recipeOfLength = (count: number) => recipe(count - countPhysicalLines(recipe()));
  const skill = (name: string, pointer = `docs/recipes/${name}.md`) =>
    `---\nname: ${name}\ndescription: Use when you ${name}.\n---\n\nFollow \`${pointer}\`.\n`;
  const complete = {
    'docs/recipes/README.md': '# Recipes\n',
    'docs/recipes/add-thing.md': recipe(),
    '.claude/skills/add-thing/SKILL.md': skill('add-thing'),
  };

  test('accepts a recipe of 80 lines, a README of 40, and a recipe with its skill', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/README.md': lines(40),
      'docs/recipes/add-long.md': recipeOfLength(80),
      '.claude/skills/add-long/SKILL.md': skill('add-long'),
    });

    expect(checkSize(repository, {})).toEqual([]);
    expect(checkRecipes(repository)).toEqual([]);
  });

  test('rejects a recipe of 81 lines and a README of 41', () => {
    const repository = repositoryWith({
      'docs/recipes/README.md': lines(41),
      'docs/recipes/add-long.md': recipeOfLength(81),
    });

    expect(checkSize(repository, {}).map(formatGuidanceViolation)).toEqual([
      'docs/recipes/add-long.md: size: 81 lines exceeds the 80-line limit for a recipe. Fix: cut it to the steps and link the rules instead of restating them, or split it into two recipes.',
      'docs/recipes/README.md: size: 41 lines exceeds the 40-line limit for the recipe README. Fix: keep the format and the table of recipes only; put anything else in the recipe it concerns.',
    ]);
  });

  test('rejects a recipe that lacks a part, has them out of order or has no title', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/no-mistakes.md': recipe().replace('## Mistakes this prevents', '## Pitfalls'),
      'docs/recipes/no-title.md': recipe().replace('# Add a thing\n', ''),
      'docs/recipes/out-of-order.md': recipe()
        .replace('## Steps', '## Temp')
        .replace('## Use when', '## Steps')
        .replace('## Temp', '## Use when'),
      '.claude/skills/no-mistakes/SKILL.md': skill('no-mistakes'),
      '.claude/skills/no-title/SKILL.md': skill('no-title'),
      '.claude/skills/out-of-order/SKILL.md': skill('out-of-order'),
    });
    const fix =
      'use the format in docs/recipes/README.md: a "# " title, then "## Use when", "## Steps" and "## Mistakes this prevents", in that order.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `docs/recipes/no-mistakes.md: recipes: has the sections "Use when", "Steps" and "Pitfalls", not "Use when", "Steps" and "Mistakes this prevents". Fix: ${fix}`,
      `docs/recipes/no-title.md: recipes: does not start with a "# " title. Fix: ${fix}`,
      `docs/recipes/out-of-order.md: recipes: has the sections "Steps", "Use when" and "Mistakes this prevents", not "Use when", "Steps" and "Mistakes this prevents". Fix: ${fix}`,
    ]);
  });

  test('rejects a recipe without its skill file', () => {
    const repository = repositoryWith({
      'docs/recipes/README.md': '# Recipes\n',
      'docs/recipes/add-thing.md': recipe(),
    });

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      'docs/recipes/add-thing.md: recipes: has no skill file at .claude/skills/add-thing/SKILL.md. Fix: create it with front matter (name, description) and one line pointing at docs/recipes/add-thing.md.',
    ]);
  });

  test('rejects a skill that points at a missing recipe, at the README or at nothing', () => {
    const repository = repositoryWith({
      ...complete,
      '.claude/skills/gone/SKILL.md': skill('gone'),
      '.claude/skills/readme/SKILL.md': skill('readme', 'docs/recipes/README.md'),
      '.claude/skills/nothing/SKILL.md': '---\nname: nothing\ndescription: Use never.\n---\n',
    });
    const fix = 'point it at the recipe it serves, or delete the skill.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `.claude/skills/gone/SKILL.md: recipes: points at docs/recipes/gone.md, which is not a recipe. Fix: ${fix}`,
      `.claude/skills/nothing/SKILL.md: recipes: does not point at a recipe under docs/recipes/. Fix: ${fix}`,
      `.claude/skills/readme/SKILL.md: recipes: points at docs/recipes/README.md, which is not a recipe. Fix: ${fix}`,
    ]);
  });

  test('checks the links and paths a recipe cites', () => {
    const repository = repositoryWith({
      ...complete,
      'src/backend/thing.ts': 'export {};\n',
      'docs/recipes/add-thing.md': `${recipe()}\nSee [the rules](../../src/area/AGENTS.md) and \`src/backend/gone.ts\`.\n`,
    });

    expect(checkReferences(repository).map(formatGuidanceViolation)).toEqual([
      expect.stringContaining(
        'docs/recipes/add-thing.md:19: references: link `../../src/area/AGENTS.md` does not exist.'
      ),
      expect.stringContaining(
        'docs/recipes/add-thing.md:19: references: `src/backend/gone.ts` does not exist.'
      ),
    ]);
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
      'src/existing.ts': 'export {};\n',
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

  test('fails a recipe that has no skill file', () => {
    const repositoryRoot = createRepository({
      'docs/recipes/add-thing.md':
        '# Add a thing\n\n## Use when\n\n## Steps\n\n## Mistakes this prevents\n',
    });

    const result = run(repositoryRoot, { baseCeilings: { notice: 'no base.' } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'docs/recipes/add-thing.md: recipes: has no skill file at .claude/skills/add-thing/SKILL.md.'
    );
  });
});
