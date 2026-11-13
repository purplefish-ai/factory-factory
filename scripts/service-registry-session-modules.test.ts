import { describe, expect, test } from 'vitest';
import {
  collectSessionModuleEdges,
  getSessionModuleErrors,
  type SessionModuleCheckInput,
  type SessionModuleDeclaration,
  type SessionModuleEdge,
} from './service-registry-session-modules';

const service = 'src/backend/services/session/service';
const modulesFile = 'src/backend/services/session/modules.ts';

function edgesOf(files: Record<string, string>, directories: string[]): string[] {
  return collectSessionModuleEdges(
    Object.entries(files).map(([path, source]) => ({ path: `${service}/${path}`, source })),
    directories
  ).map(
    (edge) => `${edge.file.slice(service.length + 1)} ${edge.to}${edge.typeOnly ? ' type' : ''}`
  );
}

describe('collectSessionModuleEdges', () => {
  const directories = ['alpha', 'beta', 'gamma', 'root'];

  test('reads relative, alias and directory specifiers, once per file and module', () => {
    expect(
      edgesOf(
        {
          'alpha/a.ts': [
            "import { b } from '../beta/b';",
            "import { c } from '../beta/nested/c';",
            "import { g } from '@/backend/services/session/service/gamma';",
            "export { r } from '../root-file';",
            "import { own } from './own';",
          ].join('\n'),
          'beta/nested/c.ts': "import { a } from '../../alpha/a';\nimport { x } from '../x';",
          'root-file.ts': "import { a } from './alpha';\nimport './gamma/side-effect';",
        },
        directories
      )
    ).toEqual([
      'alpha/a.ts beta',
      'alpha/a.ts gamma',
      'alpha/a.ts root',
      'beta/nested/c.ts alpha',
      'root-file.ts alpha',
      'root-file.ts gamma',
    ]);
  });

  test('marks a file-module edge type-only only when every import into the module is', () => {
    expect(
      edgesOf(
        {
          'alpha/types.ts': [
            "import type { B } from '../beta/b';",
            "import { type C, type D } from '../gamma/c';",
            "export type { R } from '../root-file';",
          ].join('\n'),
          'alpha/mixed.ts': [
            "import type { B } from '../beta/b';",
            "import { b } from '../beta/other';",
            "import { type C, c } from '../gamma/c';",
          ].join('\n'),
          'alpha/inline.ts': [
            "type Loader = typeof import('../beta/b');",
            "const load = () => import('../gamma/c');",
          ].join('\n'),
        },
        directories
      )
    ).toEqual([
      'alpha/types.ts beta type',
      'alpha/types.ts gamma type',
      'alpha/types.ts root type',
      'alpha/mixed.ts beta',
      'alpha/mixed.ts gamma',
      'alpha/inline.ts beta type',
      'alpha/inline.ts gamma',
    ]);
  });

  test('skips tests, test support and imports outside service/', () => {
    const importsBeta = "import { b } from '@/backend/services/session/service/beta/b';";
    expect(
      edgesOf(
        {
          'alpha/a.test.ts': importsBeta,
          'alpha/a.integration.test.ts': importsBeta,
          'alpha/a.test-helpers.ts': importsBeta,
          'alpha/a.test-support.ts': importsBeta,
          'alpha/a.test-harness.ts': importsBeta,
          'alpha/a.fixture.ts': importsBeta,
          'alpha/testing/a.ts': importsBeta,
          'alpha/test-utils/a.ts': importsBeta,
          'alpha/a.ts': [
            "import { accessor } from '../../resources/agent-session.accessor';",
            "import type { T } from '../../types';",
            "import { session } from '@/backend/services/session';",
            "import { z } from 'zod';",
          ].join('\n'),
        },
        directories
      )
    ).toEqual([]);
  });
});

const edge = (from: string, to: string, file = `${service}/${from}/x.ts`): SessionModuleEdge => ({
  from,
  to,
  file,
  typeOnly: false,
});

function check(
  modules: Record<string, readonly string[]>,
  edges: SessionModuleEdge[],
  options: Partial<Pick<SessionModuleCheckInput, 'cycles' | 'moduleDirectories'>> & {
    sealed?: readonly string[];
  } = {}
): string[] {
  return getSessionModuleErrors({
    modules: Object.fromEntries(
      Object.entries(modules).map(([name, dependsOn]): [string, SessionModuleDeclaration] => [
        name,
        { dependsOn, description: `Owns ${name}.`, sealed: options.sealed?.includes(name) },
      ])
    ),
    cycles: options.cycles ?? [],
    moduleDirectories: options.moduleDirectories ?? Object.keys(modules),
    edges,
  });
}

describe('getSessionModuleErrors', () => {
  test('accepts a map that matches the graph, including recorded cycles and sealed modules', () => {
    expect(
      check(
        { a: ['b', 'root'], b: ['a'], root: [] },
        [edge('a', 'b'), edge('a', 'root'), edge('b', 'a')],
        { cycles: [['a', 'b']], sealed: ['root'] }
      )
    ).toEqual([]);
  });

  test('rejects a module directory that sessionModules does not list', () => {
    expect(
      check({ a: [] }, [edge('b', 'a'), edge('root', 'a', `${service}/r.ts`)], {
        moduleDirectories: ['a', 'b', 'root'],
      })
    ).toEqual([
      `Session module "b" (${service}/b/) is not listed in sessionModules in ${modulesFile}. Add "b": { dependsOn: ['a'], description: '<what it owns>' }.`,
      `Session module "root" (the files directly under ${service}/) is not listed in sessionModules in ${modulesFile}. Add "root": { dependsOn: ['a'], description: '<what it owns>' }.`,
    ]);
  });

  test('rejects a listed module with no directory, and root once no files remain', () => {
    expect(check({ a: [], gone: ['a'], root: [] }, [], { moduleDirectories: ['a'] })).toEqual([
      `sessionModules in ${modulesFile} lists "gone", but ${service}/gone/ does not exist. Remove the "gone" entry.`,
      `sessionModules in ${modulesFile} lists "root", but no files are left directly under ${service}/. Remove the "root" entry.`,
    ]);
  });

  test('rejects an import missing from dependsOn, naming the files and the corrected list', () => {
    expect(
      check({ a: ['c'], b: [], c: [] }, [
        edge('a', 'b', `${service}/a/one.ts`),
        edge('a', 'b', `${service}/a/two.ts`),
        edge('a', 'c'),
      ])
    ).toEqual([
      `Session module "a" imports "b" in ${service}/a/one.ts, ${service}/a/two.ts, but sessionModules["a"].dependsOn in ${modulesFile} does not list "b". Add it; the list becomes ['b', 'c'].`,
    ]);
  });

  test('shortens long file lists', () => {
    const files = ['1', '2', '3', '4', '5'].map((name) =>
      edge('a', 'b', `${service}/a/${name}.ts`)
    );
    expect(check({ a: [], b: [] }, files)).toEqual([
      `Session module "a" imports "b" in ${service}/a/1.ts, ${service}/a/2.ts, ${service}/a/3.ts and 2 more, but sessionModules["a"].dependsOn in ${modulesFile} does not list "b". Add it; the list becomes ['b'].`,
    ]);
  });

  test('rejects a dependsOn entry with no import behind it, and a module listing itself', () => {
    expect(check({ a: ['a', 'b', 'root'], b: [], root: [] }, [edge('a', 'b')])).toEqual([
      `sessionModules["a"].dependsOn in ${modulesFile} lists "a", but a module cannot depend on itself. Remove "a"; the list becomes ['b'].`,
      `sessionModules["a"].dependsOn in ${modulesFile} lists "root", but no production file in ${service}/a/ imports the files directly under ${service}/. Remove "root"; the list becomes ['b'].`,
    ]);
  });

  test('rejects an unsorted or duplicated dependsOn', () => {
    expect(
      check({ a: ['c', 'b'], b: [], c: [], d: ['b', 'b'] }, [
        edge('a', 'b'),
        edge('a', 'c'),
        edge('d', 'b'),
      ])
    ).toEqual([
      `sessionModules["a"].dependsOn in ${modulesFile} is not sorted or has duplicates; write it as ['b', 'c'].`,
      `sessionModules["d"].dependsOn in ${modulesFile} is not sorted or has duplicates; write it as ['b'].`,
    ]);
  });

  test('rejects a new pair of modules that import each other', () => {
    expect(
      check({ a: ['b'], b: ['a'] }, [
        edge('a', 'b', `${service}/a/one.ts`),
        edge('b', 'a', `${service}/b/two.ts`),
      ])
    ).toEqual([
      `Session modules "a" and "b" import each other ("a" → "b" in ${service}/a/one.ts; "b" → "a" in ${service}/b/two.ts). Remove the imports in one direction; sessionModuleCycles in ${modulesFile} lists only the pairs that already imported each other, and may only shrink.`,
    ]);
  });

  test('rejects a recorded pair that no longer imports each other', () => {
    expect(check({ a: ['b'], b: [] }, [edge('a', 'b')], { cycles: [['a', 'b']] })).toEqual([
      `sessionModuleCycles in ${modulesFile} lists ['a', 'b'], but "a" and "b" no longer import each other. Remove the line ['a', 'b'], from sessionModuleCycles.`,
    ]);
  });

  test('rejects an unsorted pair, an unsorted list and a duplicated pair', () => {
    const modules = { a: ['b', 'c'], b: ['a'], c: ['a'] };
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('a', 'c'), edge('c', 'a')];
    expect(
      check(modules, edges, {
        cycles: [
          ['a', 'c'],
          ['b', 'a'],
        ],
      })
    ).toEqual([
      `sessionModuleCycles in ${modulesFile} lists ['b', 'a']; write each pair in sorted order, as ['a', 'b'].`,
      `sessionModuleCycles in ${modulesFile} is not sorted; order the pairs as ['a', 'b'], ['a', 'c'].`,
    ]);
    expect(
      check(modules, edges, {
        cycles: [
          ['a', 'b'],
          ['a', 'b'],
          ['a', 'c'],
        ],
      })
    ).toEqual([
      `sessionModuleCycles in ${modulesFile} lists ['a', 'b'] more than once; remove the duplicate.`,
    ]);
  });
});
