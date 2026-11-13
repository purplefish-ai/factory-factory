import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkProjectLocation } from './project-root';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ff-project-root-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const root = join(scratch, 'root');
const outside = join(scratch, 'outside');
mkdirSync(join(root, 'repo'), { recursive: true });
mkdirSync(join(outside, 'repo'), { recursive: true });
symlinkSync(join(outside, 'repo'), join(root, 'link-out'));
symlinkSync(join(root, 'repo'), join(outside, 'link-in'));

describe('project root restriction', () => {
  it('allows any path when no root is configured', () => {
    expect(checkProjectLocation(join(outside, 'repo'), null)).toEqual({ valid: true });
  });

  it('allows a repository whose real path is inside the root', () => {
    expect(checkProjectLocation(join(root, 'repo'), root)).toEqual({ valid: true });
    // A link from elsewhere that resolves inside the root.
    expect(checkProjectLocation(join(outside, 'link-in'), root)).toEqual({ valid: true });
    // A clone destination that does not exist yet.
    expect(checkProjectLocation(join(root, 'repos', 'owner', 'repo'), root)).toEqual({
      valid: true,
    });
  });

  it('rejects a repository whose real path is outside the root, saying so', () => {
    const expected = (path: string) => ({
      valid: false,
      error: `Path ${path} is outside the project root ${root}`,
    });
    expect(checkProjectLocation(join(outside, 'repo'), root)).toEqual(
      expected(join(outside, 'repo'))
    );
    expect(checkProjectLocation(join(root, 'link-out'), root)).toEqual(
      expected(join(root, 'link-out'))
    );
    expect(checkProjectLocation(join(root, '..', 'outside', 'new'), root)).toEqual(
      expected(join(root, '..', 'outside', 'new'))
    );
    expect(checkProjectLocation(root, root)).toEqual(expected(root));
  });
});
