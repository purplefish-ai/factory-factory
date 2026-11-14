import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countPhysicalLines } from './check-file-length';

export type LegacyNoteCeilings = Readonly<Record<string, number>>;

/**
 * Notes that were over the note limit when this check was introduced, each
 * capped at its line count then. A note passes at or below its ceiling, so
 * ordinary pull requests never edit this map. The pull request that migrates a
 * note lowers or removes its entry, and must remove it when it deletes the
 * note. Never raise or add one: the check compares these with the ceilings on
 * the base branch. Keep one entry per line so each migration removes only its
 * own.
 */
export const legacyNoteCeilings: LegacyNoteCeilings = {
  'docs/architecture/agent-runtime.md': 1366,
};

export const guidanceLimits = {
  agentsGuide: 120,
  note: 400,
  decision: 80,
  recipe: 80,
  recipeReadme: 40,
} as const;

export type GuidanceRule = 'size' | 'pairing' | 'references' | 'records' | 'recipes';

export type GuidanceViolation = {
  file: string;
  rule: GuidanceRule;
  problem: string;
  fix: string;
};

/** Files that exist in the working tree and Git does not ignore. */
export type GuidanceRepository = {
  files: readonly string[];
  isFile(path: string): boolean;
  exists(path: string): boolean;
  read(path: string): string;
};

export type BaseLegacyCeilings = { ref: string; ceilings: LegacyNoteCeilings } | { notice: string };

const ceilingsSourcePath = 'scripts/check-guidance.ts';
// Bare names that, in a nested guide, mean a sibling of the guide, not the
// repository root's file of that name.
const siblingGuideNames = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const fileReferenceExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.prisma',
  '.yml',
  '.yaml',
  '.css',
  '.sh',
];
const decisionNamePattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function isAgentsGuide(path: string): boolean {
  return posix.basename(path) === 'AGENTS.md';
}

function isNote(path: string): boolean {
  return /^docs\/architecture\/[^/]+\.md$/.test(path) || path === 'docs/chat-message-flow.md';
}

function isDecisionRecord(path: string): boolean {
  return path.startsWith('docs/decisions/');
}

const recipeReadmePath = 'docs/recipes/README.md';
// The parts of a recipe, in order; docs/recipes/README.md defines the format.
const recipeSections = ['Use when', 'Steps', 'Mistakes this prevents'] as const;

function isRecipeFile(path: string): boolean {
  return /^docs\/recipes\/[^/]+\.md$/.test(path);
}

function isRecipe(path: string): boolean {
  return isRecipeFile(path) && path !== recipeReadmePath;
}

function isSkillFile(path: string): boolean {
  return /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(path);
}

function isReferenceScope(path: string): boolean {
  return (
    isAgentsGuide(path) ||
    ['CONTRIBUTING.md', 'lint-rules/README.md', 'docs/README.md', 'docs/workspaces.md'].includes(
      path
    ) ||
    /^docs\/(?:architecture|recipes|decisions)\/.+\.md$/.test(path)
  );
}

function lineCount(repository: GuidanceRepository, path: string): number {
  return countPhysicalLines(repository.read(path));
}

export function checkSize(
  repository: GuidanceRepository,
  ceilings: LegacyNoteCeilings
): GuidanceViolation[] {
  const violations: GuidanceViolation[] = [];
  for (const file of repository.files) {
    if (isAgentsGuide(file)) {
      const lines = lineCount(repository, file);
      if (lines > guidanceLimits.agentsGuide) {
        violations.push({
          file,
          rule: 'size',
          problem: `${lines} lines exceeds the ${guidanceLimits.agentsGuide}-line limit for an AGENTS.md.`,
          fix: 'move detail into a nearer AGENTS.md, a linked guide or a decision record.',
        });
      }
    }
    if (isNote(file)) {
      violations.push(...checkNoteSize(file, lineCount(repository, file), ceilings[file]));
    }
    if (isRecipeFile(file)) {
      violations.push(...checkRecipeSize(file, lineCount(repository, file)));
    }
  }
  for (const [file, ceiling] of Object.entries(ceilings)) {
    if (!repository.isFile(file)) {
      violations.push({
        file,
        rule: 'size',
        problem: `has a legacy ceiling of ${ceiling} but no longer exists.`,
        fix: `remove its entry from legacyNoteCeilings in ${ceilingsSourcePath}.`,
      });
    }
  }
  return violations;
}

function checkRecipeSize(file: string, lines: number): GuidanceViolation[] {
  if (file === recipeReadmePath) {
    return lines > guidanceLimits.recipeReadme
      ? [
          {
            file,
            rule: 'size',
            problem: `${lines} lines exceeds the ${guidanceLimits.recipeReadme}-line limit for the recipe README.`,
            fix: 'keep the format and the table of recipes only; put anything else in the recipe it concerns.',
          },
        ]
      : [];
  }
  return lines > guidanceLimits.recipe
    ? [
        {
          file,
          rule: 'size',
          problem: `${lines} lines exceeds the ${guidanceLimits.recipe}-line limit for a recipe.`,
          fix: 'cut it to the steps and link the rules instead of restating them, or split it into two recipes.',
        },
      ]
    : [];
}

function checkNoteSize(
  file: string,
  lines: number,
  ceiling: number | undefined
): GuidanceViolation[] {
  const limit = guidanceLimits.note;
  if (ceiling === undefined) {
    return lines > limit
      ? [
          {
            file,
            rule: 'size',
            problem: `${lines} lines exceeds the ${limit}-line limit for a note.`,
            fix: 'move ownership and invariants into guides beside the code and reasons into decision records; do not add a legacy ceiling.',
          },
        ]
      : [];
  }
  return lines > ceiling
    ? [
        {
          file,
          rule: 'size',
          problem: `${lines} lines exceeds its legacy ceiling of ${ceiling}.`,
          fix: `bring it to ${ceiling} lines or fewer; put new guidance beside the code, not in this note.`,
        },
      ]
    : [];
}

/** A ceiling may be lowered or removed, never raised or added. */
export function compareLegacyCeilings(
  base: LegacyNoteCeilings,
  current: LegacyNoteCeilings
): GuidanceViolation[] {
  return Object.entries(current).flatMap(([file, ceiling]): GuidanceViolation[] => {
    const baseCeiling = base[file];
    if (baseCeiling === undefined) {
      return [
        {
          file,
          rule: 'size',
          problem: `legacy ceiling of ${ceiling} was added; the base branch has none.`,
          fix: `remove the entry and bring the note to ${guidanceLimits.note} lines or fewer.`,
        },
      ];
    }
    if (ceiling > baseCeiling) {
      return [
        {
          file,
          rule: 'size',
          problem: `legacy ceiling was raised from ${baseCeiling} to ${ceiling}.`,
          fix: `restore the ceiling to ${baseCeiling} or lower and bring the note within it.`,
        },
      ];
    }
    return [];
  });
}

export function checkPairing(repository: GuidanceRepository): GuidanceViolation[] {
  const violations: GuidanceViolation[] = [];
  for (const file of repository.files) {
    const name = posix.basename(file);
    const directory = posix.dirname(file);
    const sibling = (siblingName: string) =>
      directory === '.' ? siblingName : `${directory}/${siblingName}`;
    if (name === 'AGENTS.md' && !repository.isFile(sibling('CLAUDE.md'))) {
      violations.push({
        file,
        rule: 'pairing',
        problem: 'has no sibling CLAUDE.md.',
        fix: `create ${sibling('CLAUDE.md')} containing exactly @AGENTS.md.`,
      });
    }
    if (name !== 'CLAUDE.md') {
      continue;
    }
    if (!repository.isFile(sibling('AGENTS.md'))) {
      violations.push({
        file,
        rule: 'pairing',
        problem: 'has no sibling AGENTS.md.',
        fix: `move its guidance into ${sibling('AGENTS.md')} and make this file contain exactly @AGENTS.md.`,
      });
    } else if (!/^@AGENTS\.md\r?\n?$/.test(repository.read(file))) {
      violations.push({
        file,
        rule: 'pairing',
        problem: 'does not contain exactly @AGENTS.md.',
        fix: `move its guidance into ${sibling('AGENTS.md')} and make this file contain exactly @AGENTS.md.`,
      });
    }
  }
  return violations;
}

export function checkRecords(repository: GuidanceRepository): GuidanceViolation[] {
  return repository.files.filter(isDecisionRecord).flatMap((file): GuidanceViolation[] => {
    if (!decisionNamePattern.test(posix.basename(file))) {
      return [
        {
          file,
          rule: 'records',
          problem: 'is not named YYYY-MM-DD-slug.md.',
          fix: 'rename it to the decision date and a lowercase hyphenated slug, such as 2026-11-13-guidance-check.md.',
        },
      ];
    }
    const lines = lineCount(repository, file);
    return lines > guidanceLimits.decision
      ? [
          {
            file,
            rule: 'records',
            problem: `${lines} lines exceeds the ${guidanceLimits.decision}-line limit for a decision record.`,
            fix: 'record one decision and its reasons; move how-to detail into a guide beside the code.',
          },
        ]
      : [];
  });
}

function quoteList(names: readonly string[]): string {
  return names
    .map((name) => `"${name}"`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
}

const recipeFormatFix = `use the format in ${recipeReadmePath}: a "# " title, then ${quoteList(
  recipeSections.map((section) => `## ${section}`)
)}, in that order.`;

/** Whether a recipe starts with a level-1 heading, and its level-2 headings. */
function recipeOutline(content: string): { title: boolean; sections: string[] } {
  const headings = withoutFencedCode(content)
    .split('\n')
    .flatMap((line) => {
      const match = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      return match?.[1] === undefined ? [] : [{ level: match[1].length, text: match[2] ?? '' }];
    });
  return {
    title: headings[0]?.level === 1,
    sections: headings.filter((heading) => heading.level === 2).map((heading) => heading.text),
  };
}

function checkRecipeShape(repository: GuidanceRepository, file: string): GuidanceViolation[] {
  const { title, sections } = recipeOutline(repository.read(file));
  const problem = title
    ? sections.join('\n') !== recipeSections.join('\n') &&
      `has the sections ${quoteList(sections)}, not ${quoteList(recipeSections)}.`
    : 'does not start with a "# " title.';
  return problem ? [{ file, rule: 'recipes', problem, fix: recipeFormatFix }] : [];
}

/** The recipe a skill file names, as written: `docs/recipes/<name>.md`. */
function skillTarget(content: string): string | undefined {
  return /docs\/recipes\/[A-Za-z0-9._-]+\.md/.exec(content)?.[0];
}

function checkSkill(repository: GuidanceRepository, file: string): GuidanceViolation[] {
  const target = skillTarget(repository.read(file));
  const problem =
    target === undefined
      ? 'does not point at a recipe under docs/recipes/.'
      : !(isRecipe(target) && repository.isFile(target)) &&
        `points at ${target}, which is not a recipe.`;
  return problem
    ? [
        {
          file,
          rule: 'recipes',
          problem,
          fix: 'point it at the recipe it serves, or delete the skill.',
        },
      ]
    : [];
}

/** A recipe has its parts in order and a skill file; a skill points at a recipe. */
export function checkRecipes(repository: GuidanceRepository): GuidanceViolation[] {
  return repository.files.flatMap((file): GuidanceViolation[] => {
    if (isSkillFile(file)) {
      return checkSkill(repository, file);
    }
    if (!isRecipe(file)) {
      return [];
    }
    const skill = `.claude/skills/${posix.basename(file, '.md')}/SKILL.md`;
    return [
      ...checkRecipeShape(repository, file),
      ...(repository.isFile(skill)
        ? []
        : [
            {
              file,
              rule: 'recipes' as const,
              problem: `has no skill file at ${skill}.`,
              fix: `create it with front matter (name, description) and one line pointing at ${file}.`,
            },
          ]),
    ];
  });
}

/**
 * Content with `\n` line endings and fenced code blocks blanked, keeping line
 * numbers. A fence may be indented any amount, as it is inside a nested list.
 */
function withoutFencedCode(content: string): string {
  let fence: { marker: string; length: number } | undefined;
  return content
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence === undefined) {
        if (match?.[1] !== undefined) {
          fence = { marker: match[1][0] ?? '`', length: match[1].length };
          return '';
        }
        return line;
      }
      if (
        match?.[1] !== undefined &&
        match[1][0] === fence.marker &&
        match[1].length >= fence.length &&
        line.trim() === match[1]
      ) {
        fence = undefined;
      }
      return '';
    })
    .join('\n');
}

// A code span may wrap onto the next line but never crosses a blank line.
const codeSpanPattern = /`([^`\n]+(?:\n(?![ \t]*\n)[^`\n]*)*)`/g;

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let position = text.indexOf('\n'); position !== -1 && position < index;) {
    line += 1;
    position = text.indexOf('\n', position + 1);
  }
  return line;
}

/** Heading text without inline HTML tags, which GitHub renders, not slugs. */
function withoutHtmlTags(text: string): string {
  let result = '';
  let inTag = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (inTag) {
      inTag = character !== '>';
    } else if (character === '<' && /[a-z/!]/i.test(text[index + 1] ?? '')) {
      inTag = true;
    } else {
      result += character;
    }
  }
  return result;
}

export function githubHeadingSlug(heading: string): string {
  return withoutHtmlTags(heading)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

export function markdownAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  const addHeading = (heading: string) => {
    const slug = githubHeadingSlug(heading);
    const seen = occurrences.get(slug);
    anchors.add(seen === undefined ? slug : `${slug}-${seen}`);
    occurrences.set(slug, (seen ?? 0) + 1);
  };
  // Lines of the current paragraph, which a setext underline turns into a heading.
  let paragraph: string[] = [];
  for (const line of withoutFencedCode(content).split('\n')) {
    const atxHeading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (atxHeading !== undefined) {
      addHeading(atxHeading);
      paragraph = [];
    } else if (paragraph.length > 0 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      addHeading(paragraph.join(' '));
      paragraph = [];
    } else if (/^ {0,3}[^\s#>|<*+\-=]/.test(line) && !/^ {0,3}\d+[.)]\s/.test(line)) {
      paragraph.push(line.trim());
    } else {
      paragraph = [];
    }
    for (const match of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) {
      if (match[1] !== undefined) {
        anchors.add(match[1]);
      }
    }
  }
  return anchors;
}

/** The first path segments of the repository's files, split by what they name. */
export type TopLevelNames = { directories: ReadonlySet<string>; files: ReadonlySet<string> };

export function topLevelNames(files: readonly string[]): TopLevelNames {
  const directories = new Set<string>();
  const rootFiles = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf('/');
    if (slash === -1) {
      rootFiles.add(file);
    } else {
      directories.add(file.slice(0, slash));
    }
  }
  return { directories, files: rootFiles };
}

/**
 * The top-level names of a Git tree, from `git ls-tree -z <ref>` (root level
 * only). A tree or a submodule is a directory; anything else is a file.
 */
export function parseTopLevelTree(output: string): TopLevelNames {
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const entry of output.split('\0')) {
    const match = /^\d+ (blob|tree|commit) [0-9a-f]+\t(.+)$/s.exec(entry);
    if (match?.[2] !== undefined) {
      (match[1] === 'blob' ? files : directories).add(match[2]);
    }
  }
  return { directories, files };
}

/** Names at either the working tree or the base ref, so a deletion is seen. */
export function unionTopLevelNames(current: TopLevelNames, base: TopLevelNames): TopLevelNames {
  return {
    directories: new Set([...current.directories, ...base.directories]),
    files: new Set([...current.files, ...base.files]),
  };
}

/**
 * Where a code span's path is resolved from: the repository root, or, in a
 * nested guide, the guide's own directory.
 */
export type CodeSpanReference = { from: 'root' | 'guide'; path: string };

/**
 * The path a code span names, or undefined when it names none. A span names a
 * root path when it starts with a top-level directory (and has a `/`) or is a
 * root file. In a nested guide (`guideDirectory` is set) any other span that
 * ends in a file extension is a file name or path relative to the guide.
 */
export function classifyCodeSpan(
  code: string,
  topLevel: TopLevelNames,
  guideDirectory?: string
): CodeSpanReference | undefined {
  const text = code.trim();
  if (/\s/.test(text) || /[<>*{}$?[\]]/.test(text) || text.includes('...')) {
    return undefined;
  }
  const withoutLine = text.replace(/#L\d.*$/, '').replace(/:\d+(?:[-:]\d+)*$/, '');
  const nested = guideDirectory !== undefined;
  // `./name` is explicitly relative; in a nested guide it is the guide's.
  const path = nested ? withoutLine : withoutLine.replace(/^\.\//, '');
  const [first = ''] = path.split('/');
  const fromRoot = path.includes('/')
    ? topLevel.directories.has(first)
    : topLevel.files.has(path) && !siblingGuideNames.has(path);
  if (fromRoot) {
    return path.split('/').includes('..') ? undefined : { from: 'root', path };
  }
  return nested && isFileNameLike(path) ? { from: 'guide', path } : undefined;
}

/**
 * Whether a span reads as a file name or relative path: it ends in a file
 * extension after a name that is not hidden (an extension on its own, or a
 * fragment such as `.test.ts`), and is not a package, URL, flag, absolute
 * path or capitalised product name such as `Node.js`.
 */
function isFileNameLike(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return (
    !name.startsWith('.') &&
    fileReferenceExtensions.some((extension) => name.endsWith(extension)) &&
    !/^[@\-/~]/.test(path) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !/^[A-Z][A-Za-z0-9]*\.js$/.test(path)
  );
}

/**
 * Whether a file name or relative path cited in a nested guide exists. A bare
 * name matches a file of that name in the guide's directory or any directory
 * below it; a path (with `/`, or starting `../`) must exist exactly as written
 * relative to the guide's directory.
 */
export function guideReferenceExists(
  repository: Pick<GuidanceRepository, 'files' | 'isFile'>,
  guideDirectory: string,
  path: string
): boolean {
  if (path.includes('/')) {
    return repository.isFile(posix.normalize(posix.join(guideDirectory, path)));
  }
  const prefix = `${guideDirectory}/`;
  return repository.files.some((file) => file.startsWith(prefix) && posix.basename(file) === path);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function checkLinkTarget(
  repository: GuidanceRepository,
  file: string,
  target: string
): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || /[<>*{}]/.test(target)) {
    return undefined;
  }
  const hashIndex = target.indexOf('#');
  const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).replace(/\?.*$/, '');
  const anchor = hashIndex === -1 ? '' : decode(target.slice(hashIndex + 1));
  let resolved = file;
  if (pathPart !== '') {
    const joined = pathPart.startsWith('/')
      ? pathPart.slice(1)
      : posix.join(posix.dirname(file), decode(pathPart));
    resolved = posix.normalize(joined).replace(/\/$/, '');
  }
  if (resolved === '..' || resolved.startsWith('../')) {
    return `link \`${target}\` points outside the repository.`;
  }
  if (resolved !== '.' && !repository.exists(resolved)) {
    return `link \`${target}\` does not exist.`;
  }
  return hasAnchor(repository, resolved, anchor)
    ? undefined
    : `link \`${target}\` names a heading that does not exist in ${resolved}.`;
}

/** Whether a Markdown file has the anchor; other targets are not checked. */
function hasAnchor(repository: GuidanceRepository, file: string, anchor: string): boolean {
  if (anchor === '' || !file.endsWith('.md') || !repository.isFile(file)) {
    return true;
  }
  // Heading slugs are lowercase; explicit `<a id>` anchors keep their case.
  const anchors = markdownAnchors(repository.read(file));
  return anchors.has(anchor) || anchors.has(anchor.toLowerCase());
}

type ReferenceProblem = { problem: string; fix: string };

const pointToCurrentFix = 'point it at the current path or heading, or remove it.';

/**
 * What is wrong with a path written from the repository root. A path ending in
 * `/` names a directory; any other path names a file.
 */
function rootReferenceProblem(
  repository: GuidanceRepository,
  path: string
): ReferenceProblem | undefined {
  const missing = { problem: `\`${path}\` does not exist.`, fix: pointToCurrentFix };
  if (path.endsWith('/')) {
    const directory = path.slice(0, -1);
    return repository.exists(directory) && !repository.isFile(directory) ? undefined : missing;
  }
  if (repository.isFile(path)) {
    return undefined;
  }
  return repository.exists(path)
    ? {
        problem: `\`${path}\` is a directory.`,
        fix: `write it with a trailing slash, \`${path}/\`.`,
      }
    : missing;
}

function codeSpanProblem(
  repository: GuidanceRepository,
  reference: CodeSpanReference,
  guideDirectory: string | undefined
): ReferenceProblem | undefined {
  if (reference.from === 'root' || guideDirectory === undefined) {
    return rootReferenceProblem(repository, reference.path);
  }
  return guideReferenceExists(repository, guideDirectory, reference.path)
    ? undefined
    : {
        problem: `\`${reference.path}\` is not under ${guideDirectory}.`,
        fix: 'correct the name, or write the path from the repository root.',
      };
}

/** The directory of a guide that is not at the repository root, else undefined. */
function nestedGuideDirectory(file: string): string | undefined {
  const directory = posix.dirname(file);
  return isAgentsGuide(file) && directory !== '.' ? directory : undefined;
}

export function findDeadReferences(
  repository: GuidanceRepository,
  file: string,
  topLevel: TopLevelNames = topLevelNames(repository.files)
): GuidanceViolation[] {
  const prose = withoutFencedCode(repository.read(file));
  const guideDirectory = nestedGuideDirectory(file);
  const found: { index: number; violation: GuidanceViolation }[] = [];
  const report = (index: number, problem: string, fix = pointToCurrentFix) =>
    found.push({
      index,
      violation: {
        file: `${file}:${lineNumberAt(prose, index)}`,
        rule: 'references',
        problem,
        fix,
      },
    });

  for (const match of prose.matchAll(codeSpanPattern)) {
    const reference = classifyCodeSpan(match[1] ?? '', topLevel, guideDirectory);
    const problem = reference && codeSpanProblem(repository, reference, guideDirectory);
    if (problem !== undefined) {
      report(match.index, problem.problem, problem.fix);
    }
  }

  // Blank code spans so link syntax inside them is not read as a link.
  const masked = prose.replace(codeSpanPattern, (span) => span.replace(/[^\n]/g, ' '));
  const linkPatterns = [
    /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
    /^ {0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm,
  ];
  for (const pattern of linkPatterns) {
    for (const match of masked.matchAll(pattern)) {
      const problem = checkLinkTarget(repository, file, match[1] ?? '');
      if (problem !== undefined) {
        report(match.index, problem);
      }
    }
  }
  return found
    .toSorted((left, right) => left.index - right.index)
    .map(({ violation }) => violation);
}

/**
 * `baseTopLevel` holds the top-level names at the base ref. A name there but
 * not in the working tree was deleted, and a guide that still cites it fails.
 */
export function checkReferences(
  repository: GuidanceRepository,
  baseTopLevel?: TopLevelNames
): GuidanceViolation[] {
  const current = topLevelNames(repository.files);
  const topLevel = baseTopLevel === undefined ? current : unionTopLevelNames(current, baseTopLevel);
  return repository.files
    .filter(isReferenceScope)
    .flatMap((file) => findDeadReferences(repository, file, topLevel));
}

export function checkGuidance(
  repository: GuidanceRepository,
  ceilings: LegacyNoteCeilings,
  baseCeilings?: LegacyNoteCeilings,
  baseTopLevel?: TopLevelNames
): GuidanceViolation[] {
  return [
    ...checkSize(repository, ceilings),
    ...(baseCeilings === undefined ? [] : compareLegacyCeilings(baseCeilings, ceilings)),
    ...checkPairing(repository),
    ...checkReferences(repository, baseTopLevel),
    ...checkRecords(repository),
    ...checkRecipes(repository),
  ];
}

export function formatGuidanceViolation(violation: GuidanceViolation): string {
  return `${violation.file}: ${violation.rule}: ${violation.problem} Fix: ${violation.fix}`;
}

export function readGuidanceRepository(repositoryRoot: string): GuidanceRepository {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const files = [...new Set(output.split('\0'))]
    .filter((path) => path.length > 0 && existsSync(resolve(repositoryRoot, path)))
    .toSorted((left, right) => left.localeCompare(right));
  const fileSet = new Set(files);
  const directories = new Set(
    files.flatMap((path) => {
      const parts = path.split('/').slice(0, -1);
      return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
    })
  );
  return {
    files,
    isFile: (path) => fileSet.has(path),
    exists: (path) => fileSet.has(path) || directories.has(path),
    read: (path) => readFileSync(resolve(repositoryRoot, path), 'utf8'),
  };
}

/** Reads the `legacyNoteCeilings` entries from a copy of this script's source. */
export function parseLegacyNoteCeilings(source: string): LegacyNoteCeilings {
  const body = /legacyNoteCeilings\b[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/^\s*['"]([^'"]+)['"]:\s*(\d+),?\s*$/gm)].map((match) => [
      match[1] ?? '',
      Number(match[2]),
    ])
  );
}

function git(repositoryRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The commit the change is measured against: the merge base with origin/main
 * locally, or the first parent of the pull request merge commit that CI checks
 * out (CI fetches two levels of history and no origin/main).
 */
export function resolveBaseRef(repositoryRoot: string): string | undefined {
  const mergeBase = git(repositoryRoot, ['merge-base', 'HEAD', 'origin/main']);
  if (mergeBase !== undefined) {
    return mergeBase;
  }
  return git(repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^2']) === undefined
    ? undefined
    : git(repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^1']);
}

export function readBaseLegacyCeilings(repositoryRoot: string): BaseLegacyCeilings {
  const ref = resolveBaseRef(repositoryRoot);
  if (ref === undefined) {
    return {
      notice:
        'no base ref (merge base with origin/main or a merge parent); legacy ceilings were not compared with the base branch.',
    };
  }
  const source = git(repositoryRoot, ['show', `${ref}:${ceilingsSourcePath}`]);
  if (source === undefined) {
    return {
      notice: `${ceilingsSourcePath} does not exist at ${ref.slice(0, 12)}; legacy ceilings were not compared with the base branch.`,
    };
  }
  return { ref, ceilings: parseLegacyNoteCeilings(source) };
}

/** The top-level names at `ref`, or undefined when Git cannot list it. */
export function readBaseTopLevelNames(
  repositoryRoot: string,
  ref: string
): TopLevelNames | undefined {
  const output = git(repositoryRoot, ['ls-tree', '-z', ref]);
  return output === undefined ? undefined : parseTopLevelTree(output);
}

type GuidanceOutput = (message: string) => void;

export type GuidanceCliOptions = {
  repositoryRoot?: string;
  ceilings?: LegacyNoteCeilings;
  baseCeilings?: BaseLegacyCeilings;
  baseTopLevel?: TopLevelNames;
  stdout?: GuidanceOutput;
  stderr?: GuidanceOutput;
};

export function runGuidanceCli(options: GuidanceCliOptions = {}): number {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  const base = options.baseCeilings ?? readBaseLegacyCeilings(repositoryRoot);
  if ('notice' in base) {
    stdout(`Guidance check: ${base.notice}\n`);
  }

  const baseRef = 'ceilings' in base ? base.ref : resolveBaseRef(repositoryRoot);
  const violations = checkGuidance(
    readGuidanceRepository(repositoryRoot),
    options.ceilings ?? legacyNoteCeilings,
    'ceilings' in base ? base.ceilings : undefined,
    options.baseTopLevel ??
      (baseRef === undefined ? undefined : readBaseTopLevelNames(repositoryRoot, baseRef))
  );
  if (violations.length > 0) {
    stderr(`${violations.map(formatGuidanceViolation).join('\n')}\n`);
    return 1;
  }
  stdout('Guidance check passed.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runGuidanceCli();
}
