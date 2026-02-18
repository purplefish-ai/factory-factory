import { describe, expect, it } from 'vitest';
import {
  isCodexFileChangeToolName,
  parseCodexFileChangeToolInput,
  parseCodexFileChangeToolResult,
} from './file-change-parser';

describe('file-change-parser', () => {
  it('detects fileChange tool names', () => {
    expect(isCodexFileChangeToolName('fileChange')).toBe(true);
    expect(isCodexFileChangeToolName('File changes')).toBe(true);
    expect(isCodexFileChangeToolName('Read')).toBe(false);
  });

  it('parses fileChange tool input payloads', () => {
    const parsed = parseCodexFileChangeToolInput({
      type: 'fileChange',
      id: 'call_123',
      status: 'inProgress',
      changes: [
        {
          path: '/repo/src/app.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@',
        },
        {
          path: '/repo/src/new.ts',
          kind: { type: 'create', move_path: null },
        },
      ],
    });

    expect(parsed).toEqual({
      id: 'call_123',
      status: 'inProgress',
      changes: [
        {
          path: '/repo/src/app.ts',
          kind: 'update',
          diff: '@@ -1 +1 @@',
        },
        {
          path: '/repo/src/new.ts',
          kind: 'create',
        },
      ],
    });
  });

  it('parses fileChange tool result payload strings', () => {
    const parsed = parseCodexFileChangeToolResult(
      JSON.stringify({
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: '/repo/src/app.ts',
            kind: { type: 'delete', move_path: null },
          },
          {
            path: '/repo/src/moved.ts',
            kind: { type: 'move', move_path: '/repo/src/new-home.ts' },
          },
        ],
      })
    );

    expect(parsed).toMatchObject({
      status: 'completed',
      changes: [
        {
          path: '/repo/src/app.ts',
          kind: 'delete',
        },
        {
          path: '/repo/src/moved.ts',
          kind: 'move',
          movePath: '/repo/src/new-home.ts',
        },
      ],
    });
    expect(parsed?.rawText).toBeTypeOf('string');
  });

  it('parses fenced json payloads inside array tool results', () => {
    const parsed = parseCodexFileChangeToolResult([
      {
        type: 'text',
        text: '```json\n{"type":"fileChange","changes":[{"path":"/repo/src/a.ts","kind":{"type":"update"}}]}\n```',
      },
    ]);

    expect(parsed).toEqual({
      changes: [
        {
          path: '/repo/src/a.ts',
          kind: 'update',
        },
      ],
      rawText:
        '```json\n{"type":"fileChange","changes":[{"path":"/repo/src/a.ts","kind":{"type":"update"}}]}\n```',
    });
  });

  it('returns null for non-file-change payloads', () => {
    expect(parseCodexFileChangeToolResult('command output')).toBeNull();
    expect(
      parseCodexFileChangeToolInput({
        type: 'commandExecution',
        command: 'ls',
      })
    ).toBeNull();
  });
});
