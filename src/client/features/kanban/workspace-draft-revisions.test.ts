import { expect, it } from 'vitest';
import { WorkspaceDraftRevisions } from './workspace-draft-revisions';

it('retains only the current edit and explicitly pending submissions', () => {
  const revisions = new WorkspaceDraftRevisions();
  for (let index = 0; index < 5000; index++) {
    const draft = { revision: String(index) };
    const order = revisions.edit(draft);
    revisions.persisted(draft.revision, order);
  }
  expect(revisions.retained.size).toBe(1);
  revisions.clear('4999');
  expect(revisions.retained.size).toBe(0);
});

it('retains a pinned failed-save submission fallback until it finishes', () => {
  const revisions = new WorkspaceDraftRevisions();
  const old = { revision: 'disk' };
  revisions.persisted(old.revision, revisions.edit(old));
  revisions.edit({ revision: 'submitted' });
  const release = revisions.pin('submitted');
  for (let index = 0; index < 5000; index++) {
    revisions.edit({ revision: `failed-${index}` });
  }
  expect(revisions.retained.size).toBe(2);
  expect(revisions.canClear('submitted', 'disk')).toBe(true);
  expect(revisions.canClear('submitted', 'unknown-window')).toBe(false);
  const latest = { revision: 'new-disk' };
  revisions.persisted(latest.revision, revisions.edit(latest));
  expect(revisions.canClear('submitted', 'new-disk')).toBe(false);
  release();
  expect(revisions.retained.size).toBe(1);
});

it('rejects late saves without retaining completed draft objects', () => {
  const revisions = new WorkspaceDraftRevisions();
  const draft = { revision: 'discarded' };
  revisions.edit(draft);
  revisions.clear(draft.revision);
  expect(revisions.isCleared(draft)).toBe(true);
  expect(revisions.retained.size).toBe(0);
});

it('rejects a cloned save from the most recently cleared lifecycle', () => {
  const revisions = new WorkspaceDraftRevisions();
  const draft = { revision: 'cleared' };
  revisions.edit(draft);
  revisions.clear(draft.revision);
  expect(revisions.isCleared({ ...draft })).toBe(true);
});

it('releases completed lifecycle history while retaining active revision tombstones', () => {
  const revisions = new WorkspaceDraftRevisions();
  const pending = { revision: 'pending' };
  revisions.edit(pending);
  const release = revisions.pin(pending.revision);
  revisions.clear(pending.revision);
  for (let index = 0; index < 5000; index++) {
    const draft = { revision: String(index) };
    const order = revisions.edit(draft);
    revisions.persisted(draft.revision, order);
    revisions.clear(draft.revision);
    revisions.deleted(draft.revision);
  }
  expect(revisions.retained.size).toBe(1);
  expect(revisions.isCleared({ ...pending })).toBe(true);
  release();
  expect(revisions.retained.size).toBe(0);
  expect(revisions.isCleared({ revision: '4999' })).toBe(true);
});
