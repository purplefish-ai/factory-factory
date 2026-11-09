import type { BridgeEdge } from './service-registry-bridges';

/** The dependency fields of a `serviceRegistry` entry, as the checker reads them. */
export type DeclaredServiceDependencies = {
  dependsOn: readonly string[];
  bridgedDependsOn?: readonly string[];
  dataDependsOn?: Readonly<Record<string, string>>;
};

export type DeclaredDependencyCheckInput = {
  registry: Readonly<Record<string, DeclaredServiceDependencies>>;
  /** Capsules each capsule imports from non-test files. */
  importedDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  /** Bridge edges found in the orchestration wiring. */
  bridgeEdges: readonly BridgeEdge[];
};

type DeclaredEntry = { kind: string; dependency: string };

function declaredEntries(definition: DeclaredServiceDependencies): DeclaredEntry[] {
  const kinds: [string, readonly string[]][] = [
    ['dependsOn', definition.dependsOn],
    ['bridgedDependsOn', definition.bridgedDependsOn ?? []],
    ['dataDependsOn', Object.keys(definition.dataDependsOn ?? {})],
  ];
  return kinds.flatMap(([kind, dependencies]) =>
    dependencies.map((dependency) => ({ kind, dependency }))
  );
}

function entryErrors(
  serviceName: string,
  entries: readonly DeclaredEntry[],
  knownServices: ReadonlySet<string>
): string[] {
  return entries.flatMap(({ kind, dependency }) => {
    if (dependency === serviceName) {
      return [`Service "${serviceName}" lists itself in ${kind}.`];
    }
    return knownServices.has(dependency)
      ? []
      : [`Service "${serviceName}" lists unknown service "${dependency}" in ${kind}.`];
  });
}

function duplicateErrors(serviceName: string, entries: readonly DeclaredEntry[]): string[] {
  const kindsByDependency = Map.groupBy(entries, (entry) => entry.dependency);
  return [...kindsByDependency]
    .filter(([, dependencyEntries]) => dependencyEntries.length > 1)
    .map(
      ([dependency, dependencyEntries]) =>
        `Service "${serviceName}" lists "${dependency}" in more than one of ${dependencyEntries.map((entry) => entry.kind).join(', ')}; declare each dependency once, by how it is reached.`
    );
}

function missingReasonErrors(
  serviceName: string,
  definition: DeclaredServiceDependencies
): string[] {
  return Object.entries(definition.dataDependsOn ?? {})
    .filter(([, reason]) => reason.trim().length === 0)
    .map(
      ([dependency]) =>
        `Service "${serviceName}" lists "${dependency}" in dataDependsOn without a reason; say what it reads and how.`
    );
}

function unimportedErrors(
  serviceName: string,
  definition: DeclaredServiceDependencies,
  imported: ReadonlySet<string>
): string[] {
  return definition.dependsOn
    .filter((dependency) => !imported.has(dependency))
    .map(
      (dependency) =>
        `Service "${serviceName}" declares "${dependency}" in dependsOn, but no non-test file in the capsule imports it. Remove it, or move it to bridgedDependsOn (wired through configure) or dataDependsOn (non-import, with a reason).`
    );
}

function bridgeErrors(
  serviceName: string,
  definition: DeclaredServiceDependencies,
  edges: readonly BridgeEdge[]
): string[] {
  const wired = Map.groupBy(edges, (edge) => edge.to);
  const stale = (definition.bridgedDependsOn ?? [])
    .filter((dependency) => !wired.has(dependency))
    .map(
      (dependency) =>
        `Service "${serviceName}" declares "${dependency}" in bridgedDependsOn, but no orchestration configure*()/setHandler() call hands it a "${dependency}" capability. Remove the stale declaration.`
    );
  const declared = new Set([...definition.dependsOn, ...(definition.bridgedDependsOn ?? [])]);
  const undeclared = [...wired]
    .filter(([dependency]) => !declared.has(dependency))
    .map(
      ([dependency, dependencyEdges]) =>
        `Service "${serviceName}" receives "${dependency}" capabilities through orchestration wiring (${dependencyEdges.map((edge) => edge.site).join(', ')}) but does not declare "${dependency}" in bridgedDependsOn.`
    );
  return [...stale, ...undeclared];
}

/**
 * Checks that each declared dependency matches how the capsule actually reaches
 * the other capsule:
 *
 * - `dependsOn` entries must be imported by at least one non-test file;
 * - `bridgedDependsOn` entries must be wired by orchestration, and every
 *   detected bridge must be declared in `dependsOn` or `bridgedDependsOn`;
 * - `dataDependsOn` entries are non-import dependencies the checker cannot see,
 *   so each must carry a reason.
 */
export function getDeclaredDependencyErrors(input: DeclaredDependencyCheckInput): string[] {
  const knownServices = new Set(Object.keys(input.registry));
  const edgesByService = Map.groupBy(input.bridgeEdges, (edge) => edge.from);

  return Object.entries(input.registry).flatMap(([serviceName, definition]) => {
    const entries = declaredEntries(definition);
    return [
      ...entryErrors(serviceName, entries, knownServices),
      ...duplicateErrors(serviceName, entries),
      ...missingReasonErrors(serviceName, definition),
      ...unimportedErrors(
        serviceName,
        definition,
        input.importedDependencies.get(serviceName) ?? new Set()
      ),
      ...bridgeErrors(serviceName, definition, edgesByService.get(serviceName) ?? []),
    ];
  });
}
