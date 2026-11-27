import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { armCrashPoint, declaredCrashPoints, disarmCrashPoint } from './crash-points.mjs';
import { temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

/** A repository root holding only the given files. */
function repository(files: Record<string, string>) {
  const root = temporary.create('ff-crash-source-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('declared crash points', () => {
  it('include the one the queue declares', () => {
    expect(declaredCrashPoints()).toContain('after-message-queued');
  });

  it('are the literal names of crashAt calls, not of comments, strings or tests', () => {
    const root = repository({
      'src/backend/services/crash-point.ts': [
        "/** Declare one as `crashAt('<name>')`. */",
        'export function crashAt(name: string) {}',
      ].join('\n'),
      'src/backend/a.ts': [
        "crashAt('second-point');",
        "crashAt( 'first_point' );",
        "// crashAt('in-a-comment'), crashAt(name)",
        'const text = "crashAt(\'in-a-string\')";',
      ].join('\n'),
      'src/backend/deep/b.ts': "if (ready) { crashAt('third-point'); }",
      'src/backend/a.test.ts': "crashAt('only-in-a-test');",
    });
    expect(declaredCrashPoints(root)).toEqual(['first_point', 'second-point', 'third-point']);
  });

  it.each([
    ['a computed name', 'crashAt(name);', /must name its crash point with a literal/],
    ['a name with a dot', "crashAt('a.b');", /must name its crash point with a literal/],
    ['a template literal', 'crashAt(`a-${b}`);', /must name its crash point with a literal/],
    ['a name declared twice', "crashAt('twice');\ncrashAt('twice');", /declared twice/],
  ])('refuse %s', (_case, source, error) => {
    const root = repository({ 'src/backend/a.ts': source });
    expect(() => declaredCrashPoints(root)).toThrow(error);
  });
});

describe('arming a crash point', () => {
  it('fails loudly for a name no code declares, and arms nothing', () => {
    const dir = temporary.create('ff-crash-dir-');
    expect(() => armCrashPoint(dir, 'no-such-point')).toThrow(
      /No code declares crash point "no-such-point"; declared: .*after-message-queued/
    );
    expect(existsSync(join(dir, 'no-such-point'))).toBe(false);
  });

  it('arms a declared point once, until it is disarmed', () => {
    const dir = temporary.create('ff-crash-dir-');
    armCrashPoint(dir, 'after-message-queued');
    expect(existsSync(join(dir, 'after-message-queued'))).toBe(true);
    expect(() => armCrashPoint(dir, 'after-message-queued')).toThrow(/EEXIST/);
    disarmCrashPoint(dir, 'after-message-queued');
    expect(existsSync(join(dir, 'after-message-queued'))).toBe(false);
  });
});
