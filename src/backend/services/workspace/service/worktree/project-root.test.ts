import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkProjectLocation } from './project-root';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ff-project-root-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const root = join(scratch, 'root');
const outside = join(scratch, 'outside');
mkdirSync(join(root, 'repo'), { recursive: true });
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(outside, 'repo'), { recursive: true });
mkdirSync(join(outside, 'sub'), { recursive: true });
mkdirSync(join(outside, 'target'), { recursive: true });
symlinkSync(join(outside, 'repo'), join(root, 'link-out'));
symlinkSync(join(outside, 'target'), join(root, 'link'));
symlinkSync(join(root, 'repo'), join(outside, 'link-in'));

const refused = (path: string) => ({
  valid: false,
  error: `Path ${path} is outside the project root ${root}`,
});

describe('project root restriction', () => {
  it('allows any path, unchanged, when no root is configured', () => {
    expect(checkProjectLocation(join(outside, 'repo'), null)).toEqual({
      valid: true,
      path: join(outside, 'repo'),
    });
    // Not resolved: without a root, today's behaviour stores the string as given.
    expect(checkProjectLocation(`${root}/link/../sub`, null)).toEqual({
      valid: true,
      path: `${root}/link/../sub`,
    });
  });

  it('allows a repository whose real path is inside the root, and returns that real path', () => {
    expect(checkProjectLocation(join(root, 'repo'), root)).toEqual({
      valid: true,
      path: join(root, 'repo'),
    });
    // A link from elsewhere that resolves inside the root.
    expect(checkProjectLocation(join(outside, 'link-in'), root)).toEqual({
      valid: true,
      path: join(root, 'repo'),
    });
    // A clone destination that does not exist yet.
    expect(checkProjectLocation(join(root, 'repos', 'owner', 'repo'), root)).toEqual({
      valid: true,
      path: join(root, 'repos', 'owner', 'repo'),
    });
  });

  it('resolves a symbolic link before the .. that follows it, as the system does', () => {
    // The reviewer's probe: root/link/../sub is root/outside's sub on disk.
    const probe = `${root}/link/../sub`;
    expect(realpathSync.native(probe)).toBe(join(outside, 'sub'));
    expect(checkProjectLocation(probe, root)).toEqual(refused(probe));
    // A .. that stays inside the root after resolution is fine.
    expect(checkProjectLocation(`${root}/repo/../sub`, root)).toEqual({
      valid: true,
      path: join(root, 'sub'),
    });
  });

  it('refuses a .. in the part of the path that does not exist yet', () => {
    const probe = `${root}/missing/../sub`;
    expect(checkProjectLocation(probe, root)).toEqual(refused(probe));
  });

  it('refuses a dangling link, whose target is not known until it exists', () => {
    symlinkSync(join(outside, 'not-yet'), join(root, 'dangling'));
    expect(checkProjectLocation(join(root, 'dangling'), root)).toEqual(
      refused(join(root, 'dangling'))
    );
    expect(checkProjectLocation(join(root, 'dangling', 'repo'), root)).toEqual(
      refused(join(root, 'dangling', 'repo'))
    );
  });

  it('rejects a repository whose real path is outside the root, saying so', () => {
    expect(checkProjectLocation(join(outside, 'repo'), root)).toEqual(
      refused(join(outside, 'repo'))
    );
    // A symbolic link inside the root that points outside it.
    expect(checkProjectLocation(join(root, 'link-out'), root)).toEqual(
      refused(join(root, 'link-out'))
    );
    expect(checkProjectLocation(`${root}/../outside/new`, root)).toEqual(
      refused(`${root}/../outside/new`)
    );
  });

  it('rejects the root itself', () => {
    expect(checkProjectLocation(root, root)).toEqual(refused(root));
    expect(checkProjectLocation(`${root}/`, root)).toEqual(refused(`${root}/`));
    expect(checkProjectLocation(`${root}/sub/..`, root)).toEqual(refused(`${root}/sub/..`));
  });

  it('compares the case the file system resolves to', () => {
    const upper = join(scratch, 'ROOT', 'repo');
    if (existsSync(upper)) {
      // Case-insensitive file system: the same directory, stored with its real case.
      expect(checkProjectLocation(upper, root)).toEqual({ valid: true, path: join(root, 'repo') });
    } else {
      // Case-sensitive file system: a different, non-existent directory outside the root.
      expect(checkProjectLocation(upper, root)).toEqual(refused(upper));
    }
  });
});
