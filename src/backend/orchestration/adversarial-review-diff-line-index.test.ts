import { describe, expect, it } from 'vitest';
import { buildDiffLineIndex } from './adversarial-review-diff-line-index';

const SAMPLE_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index abc123..def456 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,4 +10,5 @@ function foo() {',
  ' context line 10',
  '-removed line 11',
  '+added line 11',
  '+added line 12',
  ' context line 13',
].join('\n');

describe('buildDiffLineIndex', () => {
  it('indexes added lines on the RIGHT side at their new-file line number', () => {
    const index = buildDiffLineIndex(SAMPLE_DIFF);
    expect(index.has('src/foo.ts', 'RIGHT', 11)).toBe(true);
    expect(index.has('src/foo.ts', 'RIGHT', 12)).toBe(true);
  });

  it('indexes removed lines on the LEFT side at their old-file line number', () => {
    const index = buildDiffLineIndex(SAMPLE_DIFF);
    expect(index.has('src/foo.ts', 'LEFT', 11)).toBe(true);
  });

  it('indexes context lines on the RIGHT side', () => {
    const index = buildDiffLineIndex(SAMPLE_DIFF);
    expect(index.has('src/foo.ts', 'RIGHT', 10)).toBe(true);
    expect(index.has('src/foo.ts', 'RIGHT', 13)).toBe(true);
  });

  it('rejects a line outside the diff hunk', () => {
    const index = buildDiffLineIndex(SAMPLE_DIFF);
    expect(index.has('src/foo.ts', 'RIGHT', 999)).toBe(false);
  });

  it('rejects a path that does not appear in the diff', () => {
    const index = buildDiffLineIndex(SAMPLE_DIFF);
    expect(index.has('src/other.ts', 'RIGHT', 11)).toBe(false);
  });

  it('tracks multiple files and multiple hunks independently', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old a',
      '+new a',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,1 +5,1 @@',
      '-old b',
      '+new b',
    ].join('\n');

    const index = buildDiffLineIndex(diff);
    expect(index.has('a.ts', 'RIGHT', 1)).toBe(true);
    expect(index.has('b.ts', 'RIGHT', 5)).toBe(true);
    expect(index.has('a.ts', 'RIGHT', 5)).toBe(false);
  });

  it('returns an empty index for an empty diff', () => {
    const index = buildDiffLineIndex('');
    expect(index.has('anything.ts', 'RIGHT', 1)).toBe(false);
  });

  it('does not misparse hunk content that resembles a file header', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      // A removed line whose own text starts with "-- ", which renders as
      // "--- " (three dashes) once the diff's own "-" marker is prepended.
      '--- old marker line',
      // An added line whose own text starts with "++ b/", which renders as
      // a "+++ b/..." file header once the diff's own "+" marker is prepended.
      '+++ b/not/a/real/header.ts',
    ].join('\n');

    const index = buildDiffLineIndex(diff);
    expect(index.has('src/foo.ts', 'LEFT', 2)).toBe(true);
    expect(index.has('src/foo.ts', 'RIGHT', 2)).toBe(true);
  });

  it('indexes removed lines of a deleted file on the LEFT side using the old path', () => {
    const diff = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
    ].join('\n');

    const index = buildDiffLineIndex(diff);
    expect(index.has('src/gone.ts', 'LEFT', 1)).toBe(true);
    expect(index.has('src/gone.ts', 'LEFT', 2)).toBe(true);
  });

  describe('quoted paths', () => {
    // Git C-quotes paths containing non-ASCII bytes (core.quotePath), e.g.
    // `+++ "b/lib/caf\303\251.ts"`.
    const diff = String.raw`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-old a
+new a
diff --git "a/lib/caf\303\251.ts" "b/lib/caf\303\251.ts"
index 3333333..4444444 100644
--- "a/lib/caf\303\251.ts"
+++ "b/lib/caf\303\251.ts"
@@ -50,1 +50,2 @@
 context 50
+added 51`;

    it('does not attribute a quoted-path file’s lines to the previous file', () => {
      // GitHub 422s the whole review if an inline comment targets a line
      // outside src/a.ts's hunks.
      const index = buildDiffLineIndex(diff);
      expect(index.has('src/a.ts', 'RIGHT', 50)).toBe(false);
      expect(index.has('src/a.ts', 'RIGHT', 51)).toBe(false);
    });

    it('indexes a quoted-path file under its decoded path', () => {
      const index = buildDiffLineIndex(diff);
      expect(index.has('lib/café.ts', 'RIGHT', 50)).toBe(true);
      expect(index.has('lib/café.ts', 'RIGHT', 51)).toBe(true);
    });

    it('indexes a deleted quoted-path file under its decoded old path', () => {
      const index = buildDiffLineIndex(
        String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"
deleted file mode 100644
--- "a/caf\303\251.ts"
+++ /dev/null
@@ -1,1 +0,0 @@
-gone`
      );
      expect(index.has('café.ts', 'LEFT', 1)).toBe(true);
    });
  });

  it('keeps an unquoted path containing spaces when git appends a trailing tab', () => {
    const diff = [
      'diff --git a/src/my file.ts b/src/my file.ts',
      '--- a/src/my file.ts\t',
      '+++ b/src/my file.ts\t',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const index = buildDiffLineIndex(diff);
    expect(index.has('src/my file.ts', 'RIGHT', 1)).toBe(true);
  });

  it('does not index hunks under the previous file when a header is unrecognized', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old a',
      '+new a',
      'diff --git x/b.ts y/b.ts',
      '--- x/b.ts',
      '+++ y/b.ts',
      '@@ -5,1 +5,1 @@',
      '-old b',
      '+new b',
    ].join('\n');

    const index = buildDiffLineIndex(diff);
    expect(index.has('a.ts', 'RIGHT', 1)).toBe(true);
    expect(index.has('a.ts', 'RIGHT', 5)).toBe(false);
    expect(index.has('a.ts', 'LEFT', 5)).toBe(false);
  });
});
