import ts from 'typescript';
import type { TreeFile } from './tree';

export const mockTargetClasses = [
  'client modules',
  'npm and Node',
  'capsule barrels',
  'relative paths',
  'other backend',
  'root infrastructure services',
  'session internals',
  'workspace internals',
  'other capsule internals',
  'other',
] as const;

export type MockTargetClass = (typeof mockTargetClasses)[number];

const clientPrefixes = ['@/client/', '@/components/', '@/hooks/', '@/lib/'];

function classifyServiceTarget(
  name: string,
  rest: string,
  capsules: ReadonlySet<string>
): MockTargetClass {
  if (!capsules.has(name)) {
    return 'root infrastructure services';
  }
  if (rest === '' || rest === '/index') {
    return 'capsule barrels';
  }
  if (name === 'session') {
    return 'session internals';
  }
  return name === 'workspace' ? 'workspace internals' : 'other capsule internals';
}

/** `capsules` are the directories under `src/backend/services/` with an `index.ts`. */
export function classifyMockTarget(
  target: string | null,
  capsules: ReadonlySet<string>
): MockTargetClass {
  if (target === null) {
    return 'other';
  }
  if (target.startsWith('.')) {
    return 'relative paths';
  }
  if (clientPrefixes.some((prefix) => target.startsWith(prefix))) {
    return 'client modules';
  }
  const service = /^@\/backend\/services\/([^/]+)(\/.*)?$/.exec(target);
  if (service) {
    return classifyServiceTarget(service[1] ?? '', service[2] ?? '', capsules);
  }
  if (target.startsWith('@/backend/')) {
    return 'other backend';
  }
  if (target.startsWith('@/') || target.startsWith('@prisma-gen/') || target.startsWith('/')) {
    return 'other';
  }
  return 'npm and Node';
}

export function capsuleNames(paths: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const match = /^src\/backend\/services\/([^/]+)\/index\.ts$/.exec(path);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

export type ViMockCounts = {
  calls: number;
  filesWithMocks: number;
  testFiles: number;
  byTarget: Record<MockTargetClass, number>;
};

function isViMock(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'vi' &&
    callee.name.text === 'mock'
  );
}

/**
 * The first argument of each `vi.mock(...)` call expression: its text when it
 * is a string literal, otherwise `null`. Parsed without type checking.
 */
function viMockTargets(file: TreeFile): (string | null)[] {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest);
  const targets: (string | null)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isViMock(node.expression)) {
      const [first] = node.arguments;
      targets.push(first !== undefined && ts.isStringLiteralLike(first) ? first.text : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

/** Counts `vi.mock` call expressions (not `vi.doMock`) and classifies their targets. */
export function viMockCounts(
  testFiles: readonly TreeFile[],
  capsules: ReadonlySet<string>
): ViMockCounts {
  const byTarget: Record<MockTargetClass, number> = {
    'client modules': 0,
    'npm and Node': 0,
    'capsule barrels': 0,
    'relative paths': 0,
    'other backend': 0,
    'root infrastructure services': 0,
    'session internals': 0,
    'workspace internals': 0,
    'other capsule internals': 0,
    other: 0,
  };
  let calls = 0;
  let filesWithMocks = 0;
  for (const file of testFiles) {
    const targets = viMockTargets(file);
    if (targets.length > 0) {
      filesWithMocks += 1;
    }
    for (const target of targets) {
      calls += 1;
      byTarget[classifyMockTarget(target, capsules)] += 1;
    }
  }
  return { calls, filesWithMocks, testFiles: testFiles.length, byTarget };
}
