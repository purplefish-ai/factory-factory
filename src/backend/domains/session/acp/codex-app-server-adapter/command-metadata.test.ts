import { describe, expect, it } from 'vitest';
import { buildCommandApprovalScopeKey, resolveCommandDisplay } from './command-metadata';

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

    expect(scopeKey).toBe(
      'cwd=/tmp/workspace|cd src -> /tmp/workspace/src && [cwd=/tmp/workspace/src] rg TODO README.md'
    );
  });
});
