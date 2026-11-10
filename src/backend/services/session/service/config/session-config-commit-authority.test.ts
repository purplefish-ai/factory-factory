import { expect, it } from 'vitest';
import { gate } from './session-config-authority.test-helpers';
import { SessionConfigCommitAuthority } from './session-config-commit-authority';

it('suppresses a plain I/O rejection after a newer accepted token supersedes its write', async () => {
  const authority = new SessionConfigCommitAuthority();
  const old = authority.accept('session', () => undefined);
  const held = gate();
  const error = new Error('old database request failed');
  const writing = old.persist(async () => {
    await held.wait();
    throw error;
  });
  await held.started;
  const current = authority.accept('session', () => undefined);
  held.release();
  await expect(writing).resolves.toBe(false);
  expect(current.isCurrent()).toBe(true);
});

it('preserves current I/O and runtime-source errors', async () => {
  const authority = new SessionConfigCommitAuthority();
  let stopped = false;
  const sourceError = new Error('current runtime stopped');
  const current = authority.accept('session', () => {
    if (stopped) {
      throw sourceError;
    }
  });
  const ioError = new Error('current database request failed');
  await expect(current.persist(() => Promise.reject(ioError))).rejects.toBe(ioError);
  stopped = true;
  await expect(current.persist(() => Promise.resolve())).rejects.toBe(sourceError);
});

it('propagates replacement source failure even when its token was superseded', async () => {
  const authority = new SessionConfigCommitAuthority();
  let replaced = false;
  const sourceError = new Error('runtime replaced');
  const old = authority.accept('session', () => {
    if (replaced) {
      throw sourceError;
    }
  });
  const held = gate();
  const writing = old.persist(async () => {
    await held.wait();
    throw new Error('old database request failed');
  });
  await held.started;
  authority.accept('session', () => undefined);
  replaced = true;
  held.release();
  await expect(writing).rejects.toBe(sourceError);
});

it('releases only a permanently deleted session and cannot revive its retained guard', async () => {
  const authority = new SessionConfigCommitAuthority();
  const old = authority.accept('deleted', () => undefined);
  const other = authority.accept('other', () => undefined);
  authority.release('deleted');
  expect(old.isCurrent()).toBe(false);
  expect(other.isCurrent()).toBe(true);
  const retained = authority.accept('deleted', old.assertCurrent);
  const current = authority.accept('deleted', () => undefined);
  const operations: string[] = [];
  await expect(
    retained.persist(() => {
      operations.push('revived');
      return Promise.resolve();
    })
  ).resolves.toBe(false);
  expect(operations).toEqual([]);
  expect(current.isCurrent()).toBe(true);
  expect(other.isCurrent()).toBe(true);
});
