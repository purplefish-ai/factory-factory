import { describe, expect, test } from 'vitest';
import {
  collectSessionModuleEdges,
  getSessionModuleErrors,
  sessionModuleDirectories,
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
          'alpha/spaced.ts': "const load = () => import /* lazy */ ('../root-file');",
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
      'alpha/spaced.ts root',
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

describe('sessionModuleDirectories', () => {
  test('lists directories that hold a production file, and root for top-level files', () => {
    expect(
      sessionModuleDirectories([
        `${service}/beta/nested/b.ts`,
        `${service}/alpha/a.test.ts`,
        `${service}/alpha/a.ts`,
        `${service}/top.ts`,
        'src/backend/services/session/resources/x.accessor.ts',
      ])
    ).toEqual(['alpha', 'beta', 'root']);
    expect(sessionModuleDirectories([`${service}/alpha/a.ts`])).toEqual(['alpha']);
  });

  test('does not count a directory or root that holds only tests and test support', () => {
    expect(
      sessionModuleDirectories([
        `${service}/testing/fake-runtime.ts`,
        `${service}/gamma/c.test.ts`,
        `${service}/gamma/c.test-helpers.ts`,
        `${service}/top.test.ts`,
        `${service}/alpha/a.ts`,
      ])
    ).toEqual(['alpha']);
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
  test('accepts a map that matches the graph, with a listed back edge and a sealed module', () => {
    expect(
      check(
        { a: ['b', 'root'], b: ['a'], root: [] },
        [edge('a', 'b'), edge('a', 'root'), edge('b', 'a')],
        { cycles: [['b', 'a']], sealed: ['root'] }
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
      `Session module "a" imports "b" in ${service}/a/one.ts, ${service}/a/two.ts, but sessionModules["a"].dependsOn in ${modulesFile} does not list "b". Add it (the list becomes ['b', 'c']) or remove the import.`,
    ]);
  });

  test('shortens long file lists', () => {
    const files = ['1', '2', '3', '4', '5'].map((name) =>
      edge('a', 'b', `${service}/a/${name}.ts`)
    );
    expect(check({ a: [], b: [] }, files)).toEqual([
      `Session module "a" imports "b" in ${service}/a/1.ts, ${service}/a/2.ts, ${service}/a/3.ts and 2 more, but sessionModules["a"].dependsOn in ${modulesFile} does not list "b". Add it (the list becomes ['b']) or remove the import.`,
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

  test('gives one consistent finding per cause when a new import also closes a cycle', () => {
    expect(
      check({ a: ['b'], b: ['c'], c: [] }, [
        edge('a', 'b', `${service}/a/one.ts`),
        edge('b', 'c', `${service}/b/two.ts`),
        edge('c', 'a', `${service}/c/three.ts`),
      ])
    ).toEqual([
      `Session module "c" imports "a" in ${service}/c/three.ts, which sessionModules["c"].dependsOn in ${modulesFile} does not list. The import closes a cycle, reported below, so remove it rather than listing it.`,
      `Session module "c" now imports "a", which closes an import cycle: "c" → "a" (c/three.ts) → "b" (a/one.ts) → "c" (b/two.ts), paths under ${service}/. Remove that import.`,
    ]);
  });

  test('reports a cycle through declared imports when the back edge is missing from the list', () => {
    expect(check({ a: ['b'], b: ['a'] }, [edge('a', 'b'), edge('b', 'a')])).toEqual([
      `Session modules import each other in a cycle: "a" → "b" (a/x.ts) → "a" (b/x.ts), paths under ${service}/. Remove one of these imports; sessionModuleCycles in ${modulesFile} lists the only imports allowed to close a cycle, and may only shrink.`,
    ]);
  });
});
