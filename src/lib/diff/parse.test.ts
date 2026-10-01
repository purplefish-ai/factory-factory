import { describe, expect, it } from 'vitest';
import { calculateLineNumberWidth, parseDetailedDiff, parseFileDiff } from './parse';

describe('parseDetailedDiff', () => {
  it('parses diff headers', () => {
    const diff = `diff --git a/test.txt b/test.txt
index 1234567..abcdefg 100644
--- a/test.txt
+++ b/test.txt`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'header', content: 'diff --git a/test.txt b/test.txt' });
    expect(result[1]).toEqual({ type: 'header', content: 'index 1234567..abcdefg 100644' });
    expect(result[2]).toEqual({ type: 'header', content: '--- a/test.txt' });
    expect(result[3]).toEqual({ type: 'header', content: '+++ b/test.txt' });
  });

  it('parses new file headers', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'header', content: 'diff --git a/new.txt b/new.txt' });
    expect(result[1]).toEqual({ type: 'header', content: 'new file mode 100644' });
    expect(result[2]).toEqual({ type: 'header', content: 'index 0000000..1234567' });
  });

  it('parses deleted file headers', () => {
    const diff = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'header', content: 'diff --git a/old.txt b/old.txt' });
    expect(result[1]).toEqual({ type: 'header', content: 'deleted file mode 100644' });
    expect(result[2]).toEqual({ type: 'header', content: 'index 1234567..0000000' });
  });

  it('parses hunk headers and tracks line numbers', () => {
    const diff = `@@ -10,5 +20,6 @@ function test() {`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'hunk', content: '@@ -10,5 +20,6 @@ function test() {' });
  });

  it('parses additions with correct line numbers', () => {
    const diff = `@@ -1,3 +1,4 @@
 line 1
+new line 2
 line 3`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'hunk', content: '@@ -1,3 +1,4 @@' });
    expect(result[1]).toEqual({
      type: 'context',
      content: 'line 1',
      lineNumber: { old: 1, new: 1 },
    });
    expect(result[2]).toEqual({
      type: 'addition',
      content: 'new line 2',
      lineNumber: { new: 2 },
    });
    expect(result[3]).toEqual({
      type: 'context',
      content: 'line 3',
      lineNumber: { old: 2, new: 3 },
    });
  });

  it('parses deletions with correct line numbers', () => {
    const diff = `@@ -1,4 +1,3 @@
 line 1
-deleted line 2
 line 3`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'hunk', content: '@@ -1,4 +1,3 @@' });
    expect(result[1]).toEqual({
      type: 'context',
      content: 'line 1',
      lineNumber: { old: 1, new: 1 },
    });
    expect(result[2]).toEqual({
      type: 'deletion',
      content: 'deleted line 2',
      lineNumber: { old: 2 },
    });
    expect(result[3]).toEqual({
      type: 'context',
      content: 'line 3',
      lineNumber: { old: 3, new: 2 },
    });
  });

  it('preserves header-like content and following lines across file boundaries', () => {
    const diff = `diff --git a/first.txt b/first.txt
--- a/first.txt
+++ b/first.txt
@@ -10,3 +20,3 @@
 before
--- a/header-like-content
+++ b/header-like-content
 after
diff --git a/second.txt b/second.txt
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-old
+new`;

    const result = parseDetailedDiff(diff);

    expect(result.slice(4, 8)).toEqual([
      { type: 'context', content: 'before', lineNumber: { old: 10, new: 20 } },
      { type: 'deletion', content: '-- a/header-like-content', lineNumber: { old: 11 } },
      { type: 'addition', content: '++ b/header-like-content', lineNumber: { new: 21 } },
      { type: 'context', content: 'after', lineNumber: { old: 12, new: 22 } },
    ]);
    expect(result.slice(8, 11).map((line) => line.type)).toEqual(['header', 'header', 'header']);
    expect(result.at(-1)).toEqual({ type: 'addition', content: 'new', lineNumber: { new: 1 } });
  });

  it('handles empty context lines', () => {
    const diff = `@@ -1,3 +1,3 @@
 line 1

 line 3`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(4);
    expect(result[1]).toEqual({
      type: 'context',
      content: 'line 1',
      lineNumber: { old: 1, new: 1 },
    });
    expect(result[2]).toEqual({
      type: 'context',
      content: '',
      lineNumber: { old: 2, new: 2 },
    });
    expect(result[3]).toEqual({
      type: 'context',
      content: 'line 3',
      lineNumber: { old: 3, new: 3 },
    });
  });

  it('ignores lines outside of hunks', () => {
    const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
some random line that is not in a hunk
@@ -1,2 +1,2 @@
 line 1
+added line`;

    const result = parseDetailedDiff(diff);

    // Random line outside hunk should not be parsed
    expect(result).toHaveLength(6);
    expect(result.map((l) => l.type)).toEqual([
      'header',
      'header',
      'header',
      'hunk',
      'context',
      'addition',
    ]);
  });

  it('handles multiple hunks in sequence', () => {
    const diff = `@@ -1,3 +1,3 @@
 line 1
+added line 2
 line 3
@@ -10,2 +11,3 @@
 line 10
+added line 11
 line 12`;

    const result = parseDetailedDiff(diff);

    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({ type: 'hunk', content: '@@ -1,3 +1,3 @@' });
    expect(result[2]?.lineNumber?.new).toBe(2);
    expect(result[4]).toEqual({ type: 'hunk', content: '@@ -10,2 +11,3 @@' });
    expect(result[6]?.lineNumber?.new).toBe(12);
  });

  it('handles complex real-world diff', () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdefg 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -5,10 +5,11 @@ export function example() {
   const x = 1;
   const y = 2;
-  return x + y;
+  const z = 3;
+  return x + y + z;
 }

 function helper() {`;

    const result = parseDetailedDiff(diff);

    // Should parse headers, hunk, and all changes correctly
    expect(result.length).toBeGreaterThan(0);
    const hunk = result.find((l) => l.type === 'hunk');
    expect(hunk).toBeDefined();
    const additions = result.filter((l) => l.type === 'addition');
    expect(additions).toHaveLength(2);
    const deletions = result.filter((l) => l.type === 'deletion');
    expect(deletions).toHaveLength(1);
  });
});

describe('parseFileDiff', () => {
  it.each([
    'src/lib/utils.ts',
    'web/index.ts',
    'db/schema.sql',
    '.github/workflows/ci.yml',
    'sub/nested/file.ts',
    'b/a/b/file.ts',
    'lib/a file [1] #2.txt',
    'web/my b/file.txt',
    'web/my b/file b/tail.txt',
  ])('preserves the complete destination path %s', (name) => {
    expect(parseFileDiff(`diff --git a/${name} b/${name}`)[0]?.name).toBe(name);
  });

  it.each([
    ['a/src/lib/old.ts b/web/new.ts', 'web/new.ts'],
    ['a/old name.ts b/db/new name.ts', 'db/new name.ts'],
    ['"a/lib/old\\tname.ts" b/web/new.ts', 'web/new.ts'],
    ['a/lib/old.ts "b/web/new\\tname.ts"', 'web/new\tname.ts'],
    ['"a/lib/caf\\303\\251.ts" "b/lib/caf\\303\\251.ts"', 'lib/café.ts'],
    ['"a/lib/quote\\"slash\\\\.ts" "b/lib/quote\\"slash\\\\.ts"', 'lib/quote"slash\\.ts'],
    ['"a/lib/line\\nfeed.ts" "b/lib/line\\nfeed.ts"', 'lib/line\nfeed.ts'],
    ['"a/lib/\\357\\273\\277file.ts" "b/lib/\\357\\273\\277file.ts"', 'lib/\uFEFFfile.ts'],
  ])('reads destination paths from diff --git %s', (paths, name) => {
    expect(parseFileDiff(`diff --git ${paths}`)[0]?.name).toBe(name);
  });

  it('uses rename metadata for ambiguous unquoted paths without stripping real prefixes', () => {
    const diff = `diff --git a/lib/old b/part.ts b/b/new b/part.ts
similarity index 100%
rename from lib/old b/part.ts
rename to b/new b/part.ts`;

    expect(parseFileDiff(diff)[0]).toEqual({
      name: 'b/new b/part.ts',
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it('uses copy metadata for ambiguous paths without hunks', () => {
    const diff = `diff --git a/lib/old b/part.ts b/web/new b/part.ts
similarity index 100%
copy from lib/old b/part.ts
copy to web/new b/part.ts`;

    expect(parseFileDiff(diff)[0]?.name).toBe('web/new b/part.ts');
  });

  it('decodes quoted rename destinations even when there are no hunks', () => {
    const diff = String.raw`diff --git a/lib/old.ts "b/b/caf\303\251\tnew.ts"
similarity index 100%
rename from lib/old.ts
rename to "b/caf\303\251\tnew.ts"`;

    expect(parseFileDiff(diff)[0]?.name).toBe('b/café\tnew.ts');
  });

  it('decodes destination markers and keeps literal backslashes distinct from octal escapes', () => {
    const diff = String.raw`diff --git "a/lib/old\\303.txt" "b/lib/new\\303.txt"
--- "a/lib/old\\303.txt"
+++ "b/lib/new\\303.txt"
@@ -1 +1 @@
-old
+new`;

    expect(parseFileDiff(diff)[0]?.name).toBe('lib/new\\303.txt');
  });

  it('preserves binary paths containing spaces and repeated destination-like text', () => {
    const diff = `diff --git a/web/my b/image b/icon.png b/web/my b/image b/icon.png
Binary files a/web/my b/image b/icon.png and b/web/my b/image b/icon.png differ`;

    expect(parseFileDiff(diff)[0]).toEqual({
      name: 'web/my b/image b/icon.png',
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it('uses destination markers before hunks and preserves header-like hunk content', () => {
    const diff = `diff --git a/lib/old b/part.ts b/web/new b/part.ts
--- a/lib/old b/part.ts\t
+++ b/web/new b/part.ts\t
@@ -1 +1 @@
--- a/lib/content.ts
+++ b/lib/content.ts`;

    expect(parseFileDiff(diff)[0]).toMatchObject({
      name: 'web/new b/part.ts',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          lines: [
            { type: 'del', content: '-- a/lib/content.ts' },
            { type: 'add', content: '++ b/lib/content.ts' },
          ],
        },
      ],
    });
  });

  it('preserves deleted file names and falls back for malformed headers', () => {
    expect(
      parseFileDiff(`diff --git a/db/old.sql b/db/old.sql
deleted file mode 100644
--- a/db/old.sql
+++ /dev/null
@@ -1 +0,0 @@
-old`)[0]?.name
    ).toBe('db/old.sql');
    expect(parseFileDiff('diff --git malformed lib/file.ts')[0]?.name).toBe('unknown');
  });

  it('parses a single file with additions and deletions', () => {
    const diff = `diff --git a/test.txt b/test.txt
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3`;

    const result = parseFileDiff(diff);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'test.txt',
      additions: 1,
      deletions: 1,
    });
    expect(result[0]?.hunks).toHaveLength(1);
    expect(result[0]?.hunks[0]?.lines).toHaveLength(4);
  });

  it('parses multiple files', () => {
    const diff = `diff --git a/file1.txt b/file1.txt
@@ -1,2 +1,3 @@
 line 1
+added line
 line 2
diff --git a/file2.txt b/file2.txt
@@ -1,2 +1,1 @@
-deleted line
 line 1`;

    const result = parseFileDiff(diff);

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('file1.txt');
    expect(result[0]?.additions).toBe(1);
    expect(result[0]?.deletions).toBe(0);
    expect(result[1]?.name).toBe('file2.txt');
    expect(result[1]?.additions).toBe(0);
    expect(result[1]?.deletions).toBe(1);
  });

  it('excludes +++ and --- header lines from counts', () => {
    const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,1 +1,2 @@
 line 1
+added line`;

    const result = parseFileDiff(diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.additions).toBe(1);
    expect(result[0]?.deletions).toBe(0);
  });

  it('counts header-like additions and deletions as hunk content', () => {
    const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 before
--- a/header-like-content
+++ b/header-like-content
 after`;

    expect(parseFileDiff(diff)).toEqual([
      {
        name: 'test.txt',
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: '@@ -1,3 +1,3 @@',
            lines: [
              { type: 'context', content: 'before' },
              { type: 'del', content: '-- a/header-like-content' },
              { type: 'add', content: '++ b/header-like-content' },
              { type: 'context', content: 'after' },
            ],
          },
        ],
      },
    ]);
  });

  it('handles empty lines as context', () => {
    const diff = `diff --git a/test.txt b/test.txt
@@ -1,3 +1,3 @@
 line 1

 line 3`;

    const result = parseFileDiff(diff);

    expect(result[0]?.hunks[0]?.lines).toHaveLength(3);
    expect(result[0]?.hunks[0]?.lines[1]?.type).toBe('context');
    expect(result[0]?.hunks[0]?.lines[1]?.content).toBe('');
  });
});

describe('calculateLineNumberWidth', () => {
  it('returns minimum width of 3', () => {
    const lines = [
      { type: 'context' as const, content: 'test', lineNumber: { old: 1, new: 1 } },
      { type: 'context' as const, content: 'test', lineNumber: { old: 2, new: 2 } },
    ];

    expect(calculateLineNumberWidth(lines)).toBe(3);
  });

  it('calculates width based on max line number', () => {
    const lines = [
      { type: 'context' as const, content: 'test', lineNumber: { old: 999, new: 1 } },
      { type: 'context' as const, content: 'test', lineNumber: { old: 1000, new: 1000 } },
    ];

    expect(calculateLineNumberWidth(lines)).toBe(4); // "1000" has 4 digits
  });

  it('handles lines without line numbers', () => {
    const lines = [
      { type: 'header' as const, content: 'diff --git' },
      { type: 'hunk' as const, content: '@@' },
    ];

    expect(calculateLineNumberWidth(lines)).toBe(3); // minimum
  });

  it('uses the larger of old or new line numbers', () => {
    const lines = [
      { type: 'deletion' as const, content: 'test', lineNumber: { old: 12_345 } },
      { type: 'addition' as const, content: 'test', lineNumber: { new: 100 } },
    ];

    expect(calculateLineNumberWidth(lines)).toBe(5); // "12345" has 5 digits
  });
});
