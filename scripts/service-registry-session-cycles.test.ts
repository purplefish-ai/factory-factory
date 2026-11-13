import { describe, expect, test } from 'vitest';
import {
  type BaseModulesSource,
  checkSessionModuleCyclesAgainstBase,
  cycleMembership,
  getBackEdgeErrors,
  type ModuleEdge,
  type ModuleGraph,
  parseSessionModuleCycles,
} from './service-registry-session-cycles';

const service = 'src/backend/services/session/service';
const field = 'sessionModuleCycles in src/backend/services/session/modules.ts';

/** `'a>b'` is an import from module a to module b, made by `service/a/<n>.ts`. */
function graphOf(...edges: string[]): ModuleGraph {
  const graph = new Map<string, Map<string, string[]>>();
  for (const spec of edges) {
    const [from = '', to = ''] = spec.split('>');
    const targets = graph.get(from) ?? new Map<string, string[]>();
    targets.set(to, [`${service}/${from}/to-${to}.ts`]);
    graph.set(from, targets);
  }
  return graph;
}

function errors(
  graph: ModuleGraph,
  backEdges: ModuleEdge[] = [],
  undeclaredEdges: ModuleEdge[] = []
): string[] {
  return getBackEdgeErrors({ graph, backEdges, undeclaredEdges, serviceRoot: service });
}

describe('getBackEdgeErrors', () => {
  test('accepts an acyclic graph, and one made acyclic by the listed back edges', () => {
    expect(errors(graphOf('a>b', 'b>c', 'a>c'))).toEqual([]);
    expect(
      errors(graphOf('a>b', 'b>c', 'c>a', 'b>a'), [
        ['b', 'a'],
        ['c', 'a'],
      ])
    ).toEqual([]);
  });

  test('reports one shortest cycle per component, with a file for each step', () => {
    expect(errors(graphOf('a>b', 'b>c', 'c>a', 'c>b', 'x>y', 'y>x'))).toEqual([
      `Session modules import each other in a cycle: "b" → "c" (b/to-c.ts) → "b" (c/to-b.ts), paths under ${service}/. Remove one of these imports; ${field} lists the only imports allowed to close a cycle, and may only shrink.`,
      `Session modules import each other in a cycle: "x" → "y" (x/to-y.ts) → "x" (y/to-x.ts), paths under ${service}/. Remove one of these imports; ${field} lists the only imports allowed to close a cycle, and may only shrink.`,
    ]);
  });

  test('reports a cycle that no pair shows, through the new import that closes it', () => {
    expect(
      errors(graphOf('store>dispatch', 'dispatch>data', 'data>store'), [], [['store', 'dispatch']])
    ).toEqual([
      `Session module "store" now imports "dispatch", which closes an import cycle: "store" → "dispatch" (store/to-dispatch.ts) → "data" (dispatch/to-data.ts) → "store" (data/to-store.ts), paths under ${service}/. Remove that import.`,
    ]);
  });

  test('rejects a listed edge that no longer exists', () => {
    expect(errors(graphOf('a>b'), [['b', 'a']])).toEqual([
      `${field} lists ['b', 'a'], but "b" no longer imports "a". Remove the line ['b', 'a'], from sessionModuleCycles.`,
    ]);
  });

  test('rejects listed edges no longer needed, keeping the rest of the list sufficient', () => {
    expect(errors(graphOf('a>b', 'b>c'), [['a', 'b']])).toEqual([
      `${field} lists ['a', 'b'], but it no longer closes a cycle on its own: no import path from "b" back to "a" avoids the other listed edges. Remove the line ['a', 'b'], from sessionModuleCycles.`,
    ]);
    // Either edge alone breaks a → b → c → a; only the first is reported, so the second stays.
    expect(
      errors(graphOf('a>b', 'b>c', 'c>a'), [
        ['a', 'b'],
        ['b', 'c'],
      ])
    ).toEqual([
      `${field} lists ['a', 'b'], but it no longer closes a cycle on its own: no import path from "b" back to "a" avoids the other listed edges. Remove the line ['a', 'b'], from sessionModuleCycles.`,
    ]);
  });

  test('rejects an unsorted or duplicated list', () => {
    const graph = graphOf('a>b', 'b>a', 'a>c', 'c>a');
    expect(
      errors(graph, [
        ['c', 'a'],
        ['b', 'a'],
      ])
    ).toEqual([
      `${field} is not sorted or has duplicates; write the entries as ['b', 'a'], ['c', 'a'].`,
    ]);
    expect(
      errors(graph, [
        ['b', 'a'],
        ['b', 'a'],
        ['c', 'a'],
      ])
    ).toEqual([
      `${field} is not sorted or has duplicates; write the entries as ['b', 'a'], ['c', 'a'].`,
    ]);
  });
});

describe('cycleMembership', () => {
  test('tells whether two modules share a cycle once the back edges are removed', () => {
    const sameCycle = cycleMembership(graphOf('a>b', 'b>a', 'b>c', 'c>d', 'd>c'), [['d', 'c']]);
    expect(sameCycle('a', 'b')).toBe(true);
    expect(sameCycle('b', 'c')).toBe(false);
    expect(sameCycle('c', 'd')).toBe(false);
  });
});

/** A copy of modules.ts with these modules and this cycles list, written plainly or wrapped. */
function modulesSource(
  modules: readonly string[],
  cycles: readonly ModuleEdge[],
  wrap: (list: string) => string = (list) => list
): string {
  const entries = modules.map((name) => `  '${name}': { dependsOn: [], description: 'x' },`);
  const list = `[\n${cycles.map(([from, to]) => `  ['${from}', '${to}'],`).join('\n')}\n]`;
  return [
    `export const sessionModules: Record<string, { dependsOn: readonly string[]; description: string }> = {`,
    ...entries,
    '};',
    `export const sessionModuleCycles: readonly (readonly [string, string])[] = ${wrap(list)};`,
  ].join('\n');
}

const ref = 'abcdef0123456789';
const modules = ['chat', 'composition', 'data', 'dispatch', 'root', 'store'];
const baseList: ModuleEdge[] = [
  ['dispatch', 'chat'],
  ['root', 'composition'],
  ['store', 'root'],
];
const present = (source: string): BaseModulesSource => ({ kind: 'present', ref, source });
const readError = `${field} could not be read at the base branch (abcdef012345), so entries added to it cannot be detected. The list must stay a plain array literal of two-string tuples; restore that form on main.`;

function againstBase(
  current: ModuleEdge[],
  base: Parameters<typeof checkSessionModuleCyclesAgainstBase>[0]['base'],
  currentModules: readonly string[] = modules
) {
  return checkSessionModuleCyclesAgainstBase({
    currentSource: modulesSource(currentModules, current),
    imported: current,
    base,
  });
}

describe('checkSessionModuleCyclesAgainstBase', () => {
  test('allows removing entries and rejects adding one', () => {
    const base = present(modulesSource(modules, baseList));
    expect(againstBase([['store', 'root']], base)).toEqual({ errors: [], added: false });
    expect(againstBase([...baseList, ['store', 'data']], base)).toEqual({
      errors: [
        `${field} lists ['store', 'data'], which the base branch (abcdef012345) does not; entries may be removed, never added. Remove the line, and remove the import from "store" to "data" if it closes a cycle.`,
      ],
      added: true,
    });
  });

  test('rejects a current list wrapped so the source text no longer shows it (Object.freeze)', () => {
    const base = present(modulesSource(modules, baseList));
    expect(
      checkSessionModuleCyclesAgainstBase({
        currentSource: modulesSource(modules, baseList, (list) => `Object.freeze(${list})`),
        imported: baseList,
        base,
      }).errors
    ).toEqual([
      `${field} must stay a plain array literal of two-string tuples, such as [['a', 'b']]: the check reads it from the source text to compare it with the base branch. Remove the wrapper, spread or computation around it.`,
    ]);
  });

  test('rejects a source list that differs from the imported value', () => {
    expect(
      checkSessionModuleCyclesAgainstBase({
        currentSource: modulesSource(modules, baseList),
        imported: [...baseList, ['store', 'data']],
        base: { kind: 'no-ref' },
      }).errors
    ).toEqual([
      `${field} reads differently from its source text than at run time; keep it a plain array literal of two-string tuples, with nothing computed, spread or imported.`,
    ]);
  });

  test('fails when the base has the list but it cannot be read', () => {
    const frozenBase = present(
      modulesSource(modules, baseList, (list) => `Object.freeze(${list})`)
    );
    expect(againstBase([...baseList, ['store', 'data']], frozenBase)).toEqual({
      errors: [readError],
      added: false,
    });
  });

  test('passes with a notice when there is nothing to compare', () => {
    expect(againstBase(baseList, { kind: 'no-ref' })).toEqual({
      errors: [],
      added: false,
      notice:
        'no base ref (merge base with origin/main or a merge parent); sessionModuleCycles was not compared with the base branch.',
    });
    expect(againstBase(baseList, { kind: 'absent', ref })).toEqual({
      errors: [],
      added: false,
      notice: `src/backend/services/session/modules.ts does not exist at abcdef012345; sessionModuleCycles was not compared with the base branch.`,
    });
    expect(againstBase(baseList, present('export const sessionModules = {};'))).toEqual({
      errors: [],
      added: false,
      notice: `src/backend/services/session/modules.ts has no sessionModuleCycles list at abcdef012345; sessionModuleCycles was not compared with the base branch.`,
    });
  });

  test('accepts an entry renamed with its module, but not a rename that also adds an entry', () => {
    const base = present(modulesSource(modules, baseList));
    const renamed = ['chat', 'composition', 'data', 'queue', 'root', 'store'];
    const renamedList: ModuleEdge[] = [
      ['queue', 'chat'],
      ['root', 'composition'],
      ['store', 'root'],
    ];
    expect(againstBase(renamedList, base, renamed)).toEqual({ errors: [], added: false });
    expect(againstBase([...renamedList, ['store', 'data']], base, renamed).errors).toEqual([
      `${field} lists ['queue', 'chat'], which the base branch (abcdef012345) does not; entries may be removed, never added. Remove the line, and remove the import from "queue" to "chat" if it closes a cycle.`,
      `${field} lists ['store', 'data'], which the base branch (abcdef012345) does not; entries may be removed, never added. Remove the line, and remove the import from "store" to "data" if it closes a cycle.`,
    ]);
  });

  test('turns the rename allowance off when the base module names cannot be read', () => {
    const base = present(modulesSource(modules, baseList).replace('= {', '= { ...other,'));
    expect(
      againstBase(
        [
          ['queue', 'chat'],
          ['root', 'composition'],
          ['store', 'root'],
        ],
        base
      ).added
    ).toBe(true);
  });
});

describe('a listed edge in both directions', () => {
  test('reports only the added entry, not that the other direction is unneeded', () => {
    // The reviewer's input: the base list plus ['chat', 'dispatch'].
    const graph = graphOf(
      'chat>dispatch',
      'dispatch>chat',
      'root>composition',
      'composition>root',
      'store>root',
      'root>store'
    );
    const current: ModuleEdge[] = [['chat', 'dispatch'], ...baseList];
    const base = againstBase(current, present(modulesSource(modules, baseList)));
    expect(base.errors).toEqual([
      `${field} lists ['chat', 'dispatch'], which the base branch (abcdef012345) does not; entries may be removed, never added. Remove the line, and remove the import from "chat" to "dispatch" if it closes a cycle.`,
    ]);
    expect(
      getBackEdgeErrors({
        graph,
        backEdges: current,
        undeclaredEdges: [],
        serviceRoot: service,
        reportUnneeded: !base.added,
      })
    ).toEqual([]);
  });
});

describe('parseSessionModuleCycles', () => {
  test('reads the list from a copy of modules.ts, or null when it is absent or not literal', () => {
    expect(
      parseSessionModuleCycles(
        [
          'export const sessionModules = {};',
          'export const sessionModuleCycles: readonly (readonly [string, string])[] = [',
          "  ['chat', 'dispatch'],",
          "  ['store', 'root'],",
          '] as const;',
        ].join('\n')
      )
    ).toEqual([
      ['chat', 'dispatch'],
      ['store', 'root'],
    ]);
    expect(parseSessionModuleCycles('export const sessionModules = {};')).toBeNull();
    expect(parseSessionModuleCycles('export const sessionModuleCycles = [...other];')).toBeNull();
  });
});
