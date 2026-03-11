import { describe, expect, it } from 'vitest';
import { buildCommandApprovalScopeKey, resolveCommandDisplay } from './command-metadata';

function parseScopeKey(scopeKey: string | null, cwd: string): unknown {
  expect(scopeKey).toBeTruthy();
  const prefix = `cwd=${cwd}|`;
  expect(scopeKey?.startsWith(prefix)).toBe(true);
  return JSON.parse(scopeKey!.slice(prefix.length));
}

describe('command-metadata', () => {
  it('parses escaped quotes in quoted command arguments', () => {
    const parsed = resolveCommandDisplay({
      command: 'cat "nested \\"quotes\\".md"',
      cwd: '/tmp/workspace',
    });

    expect(parsed).toEqual({
      title: 'Read nested "quotes".md',
      kind: 'read',
      locations: [{ path: '/tmp/workspace/nested "quotes".md' }],
    });
  });

  it('parses escaped single quotes and escaped spaces', () => {
    const parsed = resolveCommandDisplay({
      command: "cat 'it\\'s file.txt'",
      cwd: '/tmp/workspace',
    });

    expect(parsed).toEqual({
      title: "Read it's file.txt",
      kind: 'read',
      locations: [{ path: "/tmp/workspace/it's file.txt" }],
    });
  });

  it('derives metadata from actionable chained subcommands', () => {
    const parsed = resolveCommandDisplay({
      command: 'cd src && rg "TODO" README.md',
      cwd: '/tmp/workspace',
    });

    expect(parsed).toEqual({
      title: 'Search TODO in README.md',
      kind: 'search',
      locations: [{ path: '/tmp/workspace/README.md' }],
    });
  });

  it('keeps escaped apostrophes inside chained single-quoted args', () => {
    const parsed = resolveCommandDisplay({
      command: "cat 'it\\'s file.txt' && rg TODO README.md",
      cwd: '/tmp/workspace',
    });

    expect(parsed).toEqual({
      title: "Read it's file.txt, Search TODO in README.md",
      kind: 'read',
      locations: [{ path: "/tmp/workspace/it's file.txt" }, { path: '/tmp/workspace/README.md' }],
    });
  });

  it('builds command approval scope keys with cwd transitions', () => {
    const scopeKey = buildCommandApprovalScopeKey({
      command: 'cd src && rg TODO README.md',
      cwd: '/tmp/workspace',
    });

    expect(parseScopeKey(scopeKey, '/tmp/workspace')).toEqual([
      {
        type: 'cd',
        target: 'src',
        resolvedCwd: '/tmp/workspace/src',
        separator: '&&',
      },
      {
        type: 'cmd',
        cwd: '/tmp/workspace/src',
        tokens: ['rg', 'TODO', 'README.md'],
        separator: null,
      },
    ]);
  });

  it('builds distinct scope keys for quoted single arg vs split args', () => {
    const quotedScopeKey = buildCommandApprovalScopeKey({
      command: 'rm "file 1 file 2"',
      cwd: '/tmp/workspace',
    });
    const splitScopeKey = buildCommandApprovalScopeKey({
      command: 'rm file 1 file 2',
      cwd: '/tmp/workspace',
    });

    expect(quotedScopeKey).toBeTruthy();
    expect(splitScopeKey).toBeTruthy();
    expect(quotedScopeKey).not.toBe(splitScopeKey);
  });

  it('builds distinct scope keys for different chain operators', () => {
    const andScopeKey = buildCommandApprovalScopeKey({
      command: 'cat README.md && cat package.json',
      cwd: '/tmp/workspace',
    });
    const orScopeKey = buildCommandApprovalScopeKey({
      command: 'cat README.md || cat package.json',
      cwd: '/tmp/workspace',
    });

    expect(andScopeKey).toBeTruthy();
    expect(orScopeKey).toBeTruthy();
    expect(andScopeKey).not.toBe(orScopeKey);
  });
});
