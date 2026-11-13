import { describe, expect, test } from 'vitest';
import {
  cycleMembership,
  getAddedBackEdgeErrors,
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
      `${field} lists ['a', 'b'], but "a" → "b" no longer closes a cycle: nothing "b" imports leads back to "a". Remove the line ['a', 'b'], from sessionModuleCycles.`,
    ]);
    // Either edge alone breaks a → b → c → a; only the first is reported, so the second stays.
    expect(
      errors(graphOf('a>b', 'b>c', 'c>a'), [
        ['a', 'b'],
        ['b', 'c'],
      ])
    ).toEqual([
      `${field} lists ['a', 'b'], but "a" → "b" no longer closes a cycle: nothing "b" imports leads back to "a". Remove the line ['a', 'b'], from sessionModuleCycles.`,
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

describe('getAddedBackEdgeErrors', () => {
  test('allows removing entries and rejects adding one', () => {
    const base: ModuleEdge[] = [
      ['chat', 'dispatch'],
      ['store', 'root'],
    ];
    expect(getAddedBackEdgeErrors(base, [['store', 'root']], 'abcdef0123456789')).toEqual([]);
    expect(
      getAddedBackEdgeErrors(
        base,
        [
          ['chat', 'dispatch'],
          ['dispatch', 'chat'],
        ],
        'abcdef0123456789'
      )
    ).toEqual([
      `${field} lists ['dispatch', 'chat'], which the base branch (abcdef012345) does not; entries may be removed, never added. Remove the line, and remove the import from "dispatch" to "chat" if it closes a cycle.`,
    ]);
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
