import ts from 'typescript';

/**
 * Cycles between the session capsule's modules.
 *
 * `sessionModuleCycles` in `src/backend/services/session/modules.ts` lists
 * directed imports `[from, to]` that are allowed to close a cycle. With those
 * edges taken out, the module graph must be acyclic; each listed edge must
 * still exist and still be needed; and the list may only shrink against the
 * base branch.
 */

export const sessionModulesFile = 'src/backend/services/session/modules.ts';

/** A directed module import, `[from, to]`. */
export type ModuleEdge = readonly [string, string];

/** `from` → `to` → importing files, as repository-relative paths. */
export type ModuleGraph = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

export type BackEdgeCheckInput = {
  graph: ModuleGraph;
  /** The listed back edges, as written. */
  backEdges: readonly ModuleEdge[];
  /** Edges that are not declared in `dependsOn` yet. */
  undeclaredEdges: readonly ModuleEdge[];
  /** Shortens file paths in messages. */
  serviceRoot: string;
  /**
   * Whether to report listed edges no longer needed (default true). Off while
   * the list has an entry the base branch lacks, since that entry is the
   * finding and the rest of the list may only look unneeded because of it.
   */
  reportUnneeded?: boolean;
};

const field = `sessionModuleCycles in ${sessionModulesFile}`;
const edgeKey = ([from, to]: ModuleEdge): string => `${from}\u0000${to}`;
const quoteEdge = ([from, to]: ModuleEdge): string => `['${from}', '${to}']`;
function splitKey(key: string): ModuleEdge {
  const [from = '', to = ''] = key.split('\u0000');
  return [from, to];
}

function sortedNeighbours(graph: ModuleGraph, node: string): string[] {
  return [...(graph.get(node)?.keys() ?? [])].sort();
}

/** The graph without the given edges. */
export function withoutEdges(graph: ModuleGraph, edges: readonly ModuleEdge[]): ModuleGraph {
  const removed = new Set(edges.map(edgeKey));
  return new Map(
    [...graph].map(([from, targets]) => [
      from,
      new Map([...targets].filter(([to]) => !removed.has(edgeKey([from, to])))),
    ])
  );
}

/** Modules reachable from `start` by one or more imports. */
function reachable(graph: ModuleGraph, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  // The queue grows while it is iterated; array iteration visits appended items.
  for (const node of queue) {
    for (const next of sortedNeighbours(graph, node)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Strongly connected components with more than one module, each sorted. */
export function cyclicComponents(graph: ModuleGraph): string[][] {
  const nodes = [
    ...new Set([...graph.keys(), ...[...graph.values()].flatMap((targets) => [...targets.keys()])]),
  ].sort();
  // A few dozen modules at most: reachability from every module is cheap.
  const reach = new Map(nodes.map((node) => [node, reachable(graph, node)]));
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (assigned.has(node)) {
      continue;
    }
    const component = nodes.filter(
      (other) => other === node || (reach.get(node)?.has(other) && reach.get(other)?.has(node))
    );
    for (const member of component) {
      assigned.add(member);
    }
    if (component.length > 1) {
      components.push(component);
    }
  }
  return components;
}

/** Shortest path from `start` to `goal` (which may equal `start`), or null. */
function shortestPath(
  graph: ModuleGraph,
  start: string,
  goal: string,
  within?: ReadonlySet<string>
): string[] | null {
  const previous = new Map<string, string>();
  const pathTo = (node: string): string[] => {
    const path = [node];
    for (let step = previous.get(node); step !== undefined; step = previous.get(step)) {
      path.unshift(step);
    }
    return path;
  };
  const queue = [start];
  for (const node of queue) {
    for (const next of sortedNeighbours(graph, node)) {
      if (within !== undefined && !within.has(next)) {
        continue;
      }
      if (next === goal) {
        return [...pathTo(node), goal];
      }
      if (next !== start && !previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * A shortest cycle inside one component, as modules `[a, b, …]` that close
 * back to `a`; through one of the preferred edges when any lies in it.
 */
function componentCycle(
  graph: ModuleGraph,
  component: readonly string[],
  preferredEdges: readonly ModuleEdge[]
): string[] {
  const members = new Set(component);
  const cycles: string[][] = [];
  for (const [from, to] of preferredEdges) {
    const back = shortestPath(graph, to, from, members);
    if (back !== null) {
      cycles.push([from, ...back.slice(0, -1)]);
    }
  }
  if (cycles.length === 0) {
    for (const node of component) {
      const path = shortestPath(graph, node, node, members);
      if (path !== null) {
        cycles.push(path.slice(0, -1));
      }
    }
  }
  return cycles.reduce(
    (best, cycle) => (cycle.length < best.length ? cycle : best),
    cycles[0] ?? []
  );
}

function describeCycle(graph: ModuleGraph, cycle: readonly string[], serviceRoot: string): string {
  const steps = cycle.map((from, i) => {
    const to = cycle[(i + 1) % cycle.length] ?? '';
    const file = [...(graph.get(from)?.get(to) ?? [])].sort()[0] ?? '';
    return ` → "${to}" (${file.startsWith(`${serviceRoot}/`) ? file.slice(serviceRoot.length + 1) : file})`;
  });
  return `"${cycle[0]}"${steps.join('')}, paths under ${serviceRoot}/`;
}

function listErrors(backEdges: readonly ModuleEdge[]): string[] {
  const keys = backEdges.map(edgeKey);
  const ordered = keys.every((key, i) => i === 0 || (keys[i - 1] ?? '') < key);
  if (ordered) {
    return [];
  }
  const fixed = [...new Set(keys)].sort().map((key) => quoteEdge(splitKey(key)));
  return [`${field} is not sorted or has duplicates; write the entries as ${fixed.join(', ')}.`];
}

/**
 * Cycles left once the listed back edges are removed, listed edges that no
 * longer exist, and listed edges no longer needed to keep the rest acyclic.
 */
export function getBackEdgeErrors(input: BackEdgeCheckInput): string[] {
  const { graph, serviceRoot } = input;
  const errors = listErrors(input.backEdges);
  const listed = [...new Map(input.backEdges.map((edge) => [edgeKey(edge), edge])).values()].sort(
    (a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1)
  );
  const exists = ([from, to]: ModuleEdge): boolean => graph.get(from)?.has(to) ?? false;

  for (const edge of listed.filter((candidate) => !exists(candidate))) {
    errors.push(
      `${field} lists ${quoteEdge(edge)}, but "${edge[0]}" no longer imports "${edge[1]}". Remove the line ${quoteEdge(edge)}, from sessionModuleCycles.`
    );
  }

  const remaining = withoutEdges(graph, listed);
  const components = cyclicComponents(remaining);
  const undeclared = new Set(input.undeclaredEdges.map(edgeKey));
  for (const component of components) {
    const members = new Set(component);
    const newEdges = input.undeclaredEdges.filter(
      ([from, to]) => members.has(from) && members.has(to) && remaining.get(from)?.has(to)
    );
    const cycle = componentCycle(remaining, component, newEdges);
    const closing = cycle
      .map((from, i): ModuleEdge => [from, cycle[(i + 1) % cycle.length] ?? ''])
      .find((edge) => undeclared.has(edgeKey(edge)));
    const path = describeCycle(remaining, cycle, serviceRoot);
    errors.push(
      closing
        ? `Session module "${closing[0]}" now imports "${closing[1]}", which closes an import cycle: ${path}. Remove that import.`
        : `Session modules import each other in a cycle: ${path}. Remove one of these imports; ${field} lists the only imports allowed to close a cycle, and may only shrink.`
    );
  }
  if (components.length > 0 || input.reportUnneeded === false) {
    return errors;
  }

  // Greedy, in list order, so the lines reported as removable stay removable together.
  let kept = listed.filter(exists);
  for (const edge of [...kept]) {
    const others = kept.filter((other) => edgeKey(other) !== edgeKey(edge));
    if (shortestPath(withoutEdges(graph, [...others, edge]), edge[1], edge[0]) === null) {
      kept = others;
      errors.push(
        `${field} lists ${quoteEdge(edge)}, but it no longer closes a cycle on its own: no import path from "${edge[1]}" back to "${edge[0]}" avoids the other listed edges. Remove the line ${quoteEdge(edge)}, from sessionModuleCycles.`
      );
    }
  }
  return errors;
}

/** Whether `module` and `other` lie on a common cycle once the back edges are removed. */
export function cycleMembership(graph: ModuleGraph, backEdges: readonly ModuleEdge[]) {
  const componentOf = new Map<string, number>();
  cyclicComponents(withoutEdges(graph, backEdges)).forEach((component, i) => {
    for (const member of component) {
      componentOf.set(member, i);
    }
  });
  return (module: string, other: string): boolean =>
    componentOf.has(module) && componentOf.get(module) === componentOf.get(other);
}

/** The base branch's copy of `modules.ts`, as far as it could be found. */
export type BaseModulesSource =
  | { kind: 'no-ref' }
  | { kind: 'absent'; ref: string }
  | { kind: 'present'; ref: string; source: string };

export type CycleListBaseInput = {
  /** The working tree's `modules.ts` source text. */
  currentSource: string;
  /** `sessionModuleCycles` as imported at run time. */
  imported: readonly ModuleEdge[];
  base: BaseModulesSource;
};

export type CycleListBaseResult = {
  errors: string[];
  /** The list has an entry the base branch lacks. */
  added: boolean;
  /** Set when nothing could be compared; the check passes and prints it. */
  notice?: string;
};

const plainListForm =
  "must stay a plain array literal of two-string tuples, such as [['a', 'b']]: the check reads it from the source text to compare it with the base branch";

function sameEdges(a: readonly ModuleEdge[], b: readonly ModuleEdge[]): boolean {
  return a.length === b.length && a.every((edge, i) => edgeKey(edge) === edgeKey(b[i] ?? ['', '']));
}

/** Errors when the working tree's list cannot be read from its text, as the base will be. */
function currentFormErrors(currentSource: string, imported: readonly ModuleEdge[]): string[] {
  const parsed = parseSessionModuleCycles(currentSource);
  if (parsed === null) {
    return [`${field} ${plainListForm}. Remove the wrapper, spread or computation around it.`];
  }
  return sameEdges(parsed, imported)
    ? []
    : [
        `${field} reads differently from its source text than at run time; keep it a plain array literal of two-string tuples, with nothing computed, spread or imported.`,
      ];
}

/**
 * Entries in `current` that the base list lacks. An entry naming a module the
 * base does not have is a rename, and is accepted while the list is no longer
 * than the base list; `baseModules` null turns that allowance off.
 */
function addedEntryErrors(
  base: readonly ModuleEdge[],
  current: readonly ModuleEdge[],
  ref: string,
  baseModules: ReadonlySet<string> | null
): string[] {
  const known = new Set(base.map(edgeKey));
  const currentKeys = [...new Set(current.map(edgeKey))];
  const renameAllowed = baseModules !== null && currentKeys.length <= known.size;
  return currentKeys
    .filter((key) => !known.has(key))
    .sort()
    .map(splitKey)
    .filter(([from, to]) => !(renameAllowed && !(baseModules.has(from) && baseModules.has(to))))
    .map(
      (edge) =>
        `${field} lists ${quoteEdge(edge)}, which the base branch (${ref.slice(0, 12)}) does not; entries may be removed, never added. Remove the line, and remove the import from "${edge[0]}" to "${edge[1]}" if it closes a cycle.`
    );
}

/**
 * `sessionModuleCycles` may lose entries but never gain one. Compares the list
 * with the base branch's copy of `modules.ts`, read from text; the working
 * tree's list must therefore read the same from its text as at run time.
 */
export function checkSessionModuleCyclesAgainstBase(
  input: CycleListBaseInput
): CycleListBaseResult {
  const errors = currentFormErrors(input.currentSource, input.imported);
  const { base } = input;
  const notCompared = 'sessionModuleCycles was not compared with the base branch.';
  if (base.kind === 'no-ref') {
    return {
      errors,
      added: false,
      notice: `no base ref (merge base with origin/main or a merge parent); ${notCompared}`,
    };
  }
  const ref = base.ref.slice(0, 12);
  if (base.kind === 'absent') {
    return {
      errors,
      added: false,
      notice: `${sessionModulesFile} does not exist at ${ref}; ${notCompared}`,
    };
  }
  if (!base.source.includes('sessionModuleCycles')) {
    return {
      errors,
      added: false,
      notice: `${sessionModulesFile} has no sessionModuleCycles list at ${ref}; ${notCompared}`,
    };
  }
  const baseList = parseSessionModuleCycles(base.source);
  if (baseList === null) {
    errors.push(
      `${field} could not be read at the base branch (${ref}), so entries added to it cannot be detected. The list must stay a plain array literal of two-string tuples; restore that form on main.`
    );
    return { errors, added: false };
  }
  const added = addedEntryErrors(
    baseList,
    input.imported,
    base.ref,
    parseSessionModuleNames(base.source)
  );
  return { errors: [...errors, ...added], added: added.length > 0 };
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

/** The initializer of the top-level `const <name>`, without type wrappers. */
function initializerOf(source: string, name: string): ts.Expression | undefined {
  const file = ts.createSourceFile(sessionModulesFile, source, ts.ScriptTarget.Latest, false);
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  return declaration?.initializer && unwrap(declaration.initializer);
}

function edgeLiteral(element: ts.Expression): ModuleEdge | null {
  const tuple = unwrap(element);
  if (!ts.isArrayLiteralExpression(tuple) || tuple.elements.length !== 2) {
    return null;
  }
  const [from, to] = tuple.elements;
  return from && to && ts.isStringLiteral(from) && ts.isStringLiteral(to)
    ? [from.text, to.text]
    : null;
}

/** The `sessionModuleCycles` entries in a copy of `modules.ts`, or null when not a plain list. */
export function parseSessionModuleCycles(source: string): ModuleEdge[] | null {
  const initializer = initializerOf(source, 'sessionModuleCycles');
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
    return null;
  }
  const edges = initializer.elements.map(edgeLiteral);
  return edges.every((edge) => edge !== null) ? edges : null;
}

/** The module names keyed in `sessionModules`, or null when they cannot be read. */
export function parseSessionModuleNames(source: string): Set<string> | null {
  const initializer = initializerOf(source, 'sessionModules');
  if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
    return null;
  }
  const names = initializer.properties.map((property) =>
    ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : null
  );
  return names.every((name) => name !== null) ? new Set(names) : null;
}
