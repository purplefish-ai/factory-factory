import { describe, expect, test } from 'vitest';
import type { BridgeEdge } from './service-registry-bridges';
import {
  type DeclaredDependencyCheckInput,
  type DeclaredServiceDependencies,
  getDeclaredDependencyErrors,
} from './service-registry-dependencies';

function check(
  registry: Record<string, DeclaredServiceDependencies>,
  imports: Record<string, string[]> = {},
  bridgeEdges: BridgeEdge[] = []
): string[] {
  const input: DeclaredDependencyCheckInput = {
    registry,
    importedDependencies: new Map(
      Object.entries(imports).map(([service, dependencies]) => [service, new Set(dependencies)])
    ),
    bridgeEdges,
  };
  return getDeclaredDependencyErrors(input);
}

const edge = (from: string, to: string, line = 1): BridgeEdge => ({
  from,
  to,
  site: `src/backend/orchestration/domain-bridges.orchestrator.ts:${line}`,
});

describe('getDeclaredDependencyErrors', () => {
  test('accepts imported, bridged and justified data dependencies', () => {
    expect(
      check(
        {
          a: { dependsOn: ['b'], bridgedDependsOn: ['c'] },
          b: { dependsOn: [], dataDependsOn: { c: 'Reads C rows with raw SQL.' } },
          c: { dependsOn: [] },
        },
        { a: ['b'] },
        [edge('a', 'c')]
      )
    ).toEqual([]);
  });

  test('rejects a dependsOn entry that no non-test file imports', () => {
    expect(check({ a: { dependsOn: ['b'] }, b: { dependsOn: [] } })).toEqual([
      'Service "a" declares "b" in dependsOn, but no non-test file in the capsule imports it. Remove it, or move it to bridgedDependsOn (wired through configure) or dataDependsOn (non-import, with a reason).',
    ]);
  });

  test('accepts a bridge to a service that is also imported directly', () => {
    expect(
      check({ a: { dependsOn: ['b'] }, b: { dependsOn: [] } }, { a: ['b'] }, [edge('a', 'b')])
    ).toEqual([]);
  });

  test('rejects a wired bridge that is not declared, citing the wiring sites', () => {
    expect(
      check({ a: { dependsOn: [] }, b: { dependsOn: [] } }, {}, [
        edge('a', 'b', 7),
        edge('a', 'b', 9),
      ])
    ).toEqual([
      'Service "a" receives "b" capabilities through orchestration wiring (src/backend/orchestration/domain-bridges.orchestrator.ts:7, src/backend/orchestration/domain-bridges.orchestrator.ts:9) but does not declare "b" in bridgedDependsOn.',
    ]);
  });

  test('rejects a declared bridge that orchestration no longer wires', () => {
    expect(check({ a: { dependsOn: [], bridgedDependsOn: ['b'] }, b: { dependsOn: [] } })).toEqual([
      'Service "a" declares "b" in bridgedDependsOn, but no orchestration configure*()/setHandler() call hands it a "b" capability. Remove the stale declaration.',
    ]);
  });

  test('rejects data dependencies without a reason', () => {
    expect(
      check({ a: { dependsOn: [], dataDependsOn: { b: '  ' } }, b: { dependsOn: [] } })
    ).toEqual([
      'Service "a" lists "b" in dataDependsOn without a reason; say what it reads and how.',
    ]);
  });

  test('rejects unknown services, self references and double declarations', () => {
    expect(
      check(
        {
          a: { dependsOn: ['b'], bridgedDependsOn: ['b', 'a'], dataDependsOn: { z: 'Reads Z.' } },
          b: { dependsOn: [] },
        },
        { a: ['b'] },
        [edge('a', 'b')]
      )
    ).toEqual([
      'Service "a" lists itself in bridgedDependsOn.',
      'Service "a" lists unknown service "z" in dataDependsOn.',
      'Service "a" lists "b" in more than one of dependsOn, bridgedDependsOn; declare each dependency once, by how it is reached.',
      'Service "a" declares "a" in bridgedDependsOn, but no orchestration configure*()/setHandler() call hands it a "a" capability. Remove the stale declaration.',
    ]);
  });
});
