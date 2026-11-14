import { afterEach, describe, expect, test } from 'vitest';
import { countPhysicalLines } from './check-file-length';
import {
  checkRecipes,
  checkReferences,
  checkSize,
  formatGuidanceViolation,
} from './check-guidance';
import { lines, removeTemporaryRepositories, repositoryWith } from './check-guidance.test-support';

afterEach(removeTemporaryRepositories);

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
      'docs/recipes/prose-first.md': `Read this first.\n\n${recipe()}`,
      'docs/recipes/two-titles.md': `${recipe()}\n# Another title\n`,
      'docs/recipes/out-of-order.md': recipe()
        .replace('## Steps', '## Temp')
        .replace('## Use when', '## Steps')
        .replace('## Temp', '## Use when'),
      '.claude/skills/no-mistakes/SKILL.md': skill('no-mistakes'),
      '.claude/skills/no-title/SKILL.md': skill('no-title'),
      '.claude/skills/prose-first/SKILL.md': skill('prose-first'),
      '.claude/skills/two-titles/SKILL.md': skill('two-titles'),
      '.claude/skills/out-of-order/SKILL.md': skill('out-of-order'),
    });
    const fix =
      'use the format in docs/recipes/README.md: a "# " title, then "## Use when", "## Steps" and "## Mistakes this prevents", in that order.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `docs/recipes/no-mistakes.md: recipes: has the sections "Use when", "Steps" and "Pitfalls", not "Use when", "Steps" and "Mistakes this prevents". Fix: ${fix}`,
      `docs/recipes/no-title.md: recipes: does not have exactly one "# " title, as its first line. Fix: ${fix}`,
      `docs/recipes/out-of-order.md: recipes: has the sections "Steps", "Use when" and "Mistakes this prevents", not "Use when", "Steps" and "Mistakes this prevents". Fix: ${fix}`,
      `docs/recipes/prose-first.md: recipes: does not have exactly one "# " title, as its first line. Fix: ${fix}`,
      `docs/recipes/two-titles.md: recipes: does not have exactly one "# " title, as its first line. Fix: ${fix}`,
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
      '.claude/skills/README/SKILL.md': skill('README', 'docs/recipes/README.md'),
      '.claude/skills/nothing/SKILL.md': '---\nname: nothing\ndescription: Use never.\n---\n',
    });
    const fix = 'point it at the recipe it serves, or delete the skill.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `.claude/skills/gone/SKILL.md: recipes: points at docs/recipes/gone.md, which is not a recipe. Fix: ${fix}`,
      `.claude/skills/nothing/SKILL.md: recipes: does not point at a recipe under docs/recipes/. Fix: ${fix}`,
      `.claude/skills/README/SKILL.md: recipes: points at docs/recipes/README.md, which is not a recipe. Fix: ${fix}`,
    ]);
  });

  test('rejects a skill that points at another recipe than the one of its name', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/add-other.md': recipe(),
      '.claude/skills/add-other/SKILL.md': skill('add-other', 'docs/recipes/add-thing.md'),
    });

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      '.claude/skills/add-other/SKILL.md: recipes: points at docs/recipes/add-thing.md, not docs/recipes/add-other.md. Fix: point it at the recipe it serves, or delete the skill.',
    ]);
  });

  test('rejects a skill without front matter, a description or its directory name', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/add-bare.md': recipe(),
      'docs/recipes/add-nameless.md': recipe(),
      'docs/recipes/add-other.md': recipe(),
      '.claude/skills/add-bare/SKILL.md': 'Follow `docs/recipes/add-bare.md`.\n',
      '.claude/skills/add-nameless/SKILL.md':
        '---\nname: add-nameless\n---\n\nFollow `docs/recipes/add-nameless.md`.\n',
      '.claude/skills/add-other/SKILL.md':
        '---\nname: add-thing\ndescription: Use it.\n---\n\nFollow `docs/recipes/add-other.md`.\n',
    });
    const fix =
      'start it with --- front matter holding name (the directory name) and description (when to use it).';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `.claude/skills/add-bare/SKILL.md: recipes: has no front matter with a name and a description. Fix: ${fix}`,
      `.claude/skills/add-nameless/SKILL.md: recipes: has no front matter with a name and a description. Fix: ${fix}`,
      `.claude/skills/add-other/SKILL.md: recipes: names itself "add-thing", not "add-other". Fix: ${fix}`,
    ]);
  });

  test('rejects a skill that holds more than its front matter and one pointer line', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/add-long.md': recipe(),
      '.claude/skills/add-long/SKILL.md': `${skill('add-long')}\n2. Then run \`pnpm check\`.\n`,
    });

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      '.claude/skills/add-long/SKILL.md: recipes: has 2 lines after its front matter; a skill holds one pointer line. Fix: move the procedure into the recipe it points at and leave only the pointer line.',
    ]);
  });

  test('a pointer in the front matter does not count as the pointer line', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/add-front.md': recipe(),
      '.claude/skills/add-front/SKILL.md':
        '---\nname: add-front\ndescription: Use docs/recipes/add-front.md.\n---\n\nRun `pnpm check`.\n',
    });

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      '.claude/skills/add-front/SKILL.md: recipes: does not point at a recipe under docs/recipes/. Fix: point it at the recipe it serves, or delete the skill.',
    ]);
  });

  test('rejects files under docs/recipes/ that no recipe rule would read', () => {
    const repository = repositoryWith({
      ...complete,
      'docs/recipes/sub/long.md': lines(200),
      'docs/recipes/upper.MD': lines(200),
      'docs/recipes/Mixed.md': lines(200),
      'docs/recipes/diagram.png': 'png',
    });
    const problem = 'is not a top-level lower-case .md file, so no recipe rule applies to it.';
    const fix =
      'put it at docs/recipes/<lower-case-name>.md as a recipe, or outside docs/recipes/.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `docs/recipes/diagram.png: recipes: ${problem} Fix: ${fix}`,
      `docs/recipes/Mixed.md: recipes: ${problem} Fix: ${fix}`,
      `docs/recipes/sub/long.md: recipes: ${problem} Fix: ${fix}`,
      `docs/recipes/upper.MD: recipes: ${problem} Fix: ${fix}`,
    ]);
    expect(checkSize(repository, {})).toEqual([]);
  });

  test('rejects a SKILL.md that is not exactly one directory deep', () => {
    const repository = repositoryWith({
      ...complete,
      '.claude/skills/SKILL.md': skill('add-thing'),
      '.claude/skills/group/add-thing/SKILL.md': skill('add-thing'),
    });
    const problem = 'is not .claude/skills/<name>/SKILL.md, so it is no skill and is not checked.';
    const fix = 'move it to .claude/skills/<recipe-name>/SKILL.md.';

    expect(checkRecipes(repository).map(formatGuidanceViolation)).toEqual([
      `.claude/skills/group/add-thing/SKILL.md: recipes: ${problem} Fix: ${fix}`,
      `.claude/skills/SKILL.md: recipes: ${problem} Fix: ${fix}`,
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
