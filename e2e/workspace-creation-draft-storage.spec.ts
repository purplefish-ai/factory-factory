import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    loadDraftStorage: () => Promise<
      typeof import('../src/client/features/kanban/workspace-creation-draft-storage')
    >;
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__draft-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
  );
  await page.addInitScript(
    "window.loadDraftStorage = () => import('/src/client/features/kanban/workspace-creation-draft-storage.ts')"
  );
  await page.goto('/__draft-test');
});

test.describe('workspace draft storage in Chromium', () => {
  test('round trips attachments after refresh and isolates projects', async ({ page }) => {
    await page.evaluate(async () => {
      const storage = await window.loadDraftStorage();
      await storage.saveWorkspaceCreationDraft('roundtrip', {
        ...storage.createWorkspaceCreationDraft(),
        revision: 'first',
        prompt: 'Keep me',
        attachments: [
          {
            id: 'a',
            name: 'notes.txt',
            type: 'text/plain',
            size: 4,
            data: 'text',
            contentType: 'text',
          },
        ],
      });
    });
    await page.reload();
    const result = await page.evaluate(async () => {
      const storage = await window.loadDraftStorage();
      return [
        await storage.loadWorkspaceCreationDraft('roundtrip'),
        await storage.loadWorkspaceCreationDraft('other'),
      ];
    });
    expect(result[0]).toMatchObject({
      prompt: 'Keep me',
      attachments: [{ data: 'text', contentType: 'text' }],
    });
    expect(result[1]).toBeNull();
  });

  test('makes an enqueued edit immediately readable before persistence finishes', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const s = await window.loadDraftStorage();
      const pending = s.saveWorkspaceCreationDraft('immediate', {
        ...s.createWorkspaceCreationDraft(),
        prompt: 'Navigate now',
      });
      const draft = await s.loadWorkspaceCreationDraft('immediate');
      await pending;
      return draft;
    });
    expect(result).toMatchObject({ prompt: 'Navigate now' });
  });

  test('serializes writes and prevents late old saves from resurrecting cleared revisions', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const s = await window.loadDraftStorage();
      const old = { ...s.createWorkspaceCreationDraft(), revision: 'old', prompt: 'Old' };
      const first = s.saveWorkspaceCreationDraft('ordered', old);
      const clear = s.clearWorkspaceCreationDraft('ordered', 'old');
      const late = s.saveWorkspaceCreationDraft('ordered', old);
      const clonedLate = s.saveWorkspaceCreationDraft('ordered', { ...old });
      await Promise.all([first, clear, late, clonedLate]);
      const absent = await s.loadWorkspaceCreationDraft('ordered');
      await s.saveWorkspaceCreationDraft('ordered', { ...old, revision: 'new', prompt: 'New' });
      await s.clearWorkspaceCreationDraft('ordered', 'old');
      return [absent, await s.loadWorkspaceCreationDraft('ordered')];
    });
    expect(result[0]).toBeNull();
    expect(result[1]).toMatchObject({ prompt: 'New', revision: 'new' });
    await page.reload();
    expect(
      await page.evaluate(async () =>
        (await window.loadDraftStorage()).loadWorkspaceCreationDraft('ordered')
      )
    ).toMatchObject({ prompt: 'New' });
  });

  test('rejects malformed records without silently dropping attachments', async ({ page }) => {
    const error = await page.evaluate(async () => {
      const s = await window.loadDraftStorage();
      await s.saveWorkspaceCreationDraft('malformed', s.createWorkspaceCreationDraft());
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('factory-factory-workspace-drafts', 1);
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ schemaVersion: 999, attachments: 'lost' }, 'corrupt');
        tx.oncomplete = () => resolve();
      });
      db.close();
      try {
        await s.loadWorkspaceCreationDraft('corrupt');
        return '';
      } catch (e) {
        return String(e);
      }
    });
    expect(error).toContain('could not be restored');
  });

  test('bounds blocked opening and retains usable memory after storage failure', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      Object.defineProperty(window, 'indexedDB', {
        value: { open: () => ({}) },
        configurable: true,
      });
      const s = await window.loadDraftStorage();
      const start = Date.now();
      let error = '';
      try {
        await s.saveWorkspaceCreationDraft('blocked', {
          ...s.createWorkspaceCreationDraft(),
          prompt: 'Still editable',
        });
      } catch (e) {
        error = String(e);
      }
      return {
        elapsed: Date.now() - start,
        error,
        draft: await s.loadWorkspaceCreationDraft('blocked'),
      };
    });
    expect(result.elapsed).toBeLessThan(4000);
    expect(result.error).toContain('saved');
    expect(result.draft).toMatchObject({ prompt: 'Still editable' });
  });

  test('reports quota failures and keeps the latest edit in memory', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const s = await window.loadDraftStorage();
      await s.saveWorkspaceCreationDraft('quota', s.createWorkspaceCreationDraft());
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('Full', 'QuotaExceededError');
      };
      let error = '';
      try {
        await s.saveWorkspaceCreationDraft('quota', {
          ...s.createWorkspaceCreationDraft(),
          prompt: 'Keep editing',
        });
      } catch (e) {
        error = String(e);
      }
      return { error, draft: await s.loadWorkspaceCreationDraft('quota') };
    });
    expect(result.error).toContain('saved');
    expect(result.draft).toMatchObject({ prompt: 'Keep editing' });
  });
});

test('clears a persisted ancestor after the latest save fails', async ({ page }) => {
  await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('ancestor', {
      ...s.createWorkspaceCreationDraft(),
      revision: 'old',
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
    try {
      await s.saveWorkspaceCreationDraft('ancestor', {
        ...s.createWorkspaceCreationDraft(),
        revision: 'latest',
      });
      throw new Error('Expected quota rejection');
    } catch (error) {
      if (!String(error).includes('could not be saved')) {
        throw error;
      }
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    await s.clearWorkspaceCreationDraft('ancestor', 'latest');
  });
  await page.reload();
  expect(
    await page.evaluate(async () =>
      (await window.loadDraftStorage()).loadWorkspaceCreationDraft('ancestor')
    )
  ).toBeNull();
});

test('explicitly discards unreadable records but preserves a concurrent valid replacement', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('seed', s.createWorkspaceCreationDraft());
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(s.WORKSPACE_DRAFT_DATABASE_NAME, s.WORKSPACE_DRAFT_DATABASE_VERSION);
      r.onsuccess = () => resolve(r.result);
    });
    const put = (id: string, value: unknown) =>
      new Promise<void>((resolve) => {
        const tx = db.transaction(s.WORKSPACE_DRAFT_STORE_NAME, 'readwrite');
        tx.objectStore(s.WORKSPACE_DRAFT_STORE_NAME).put(value, id);
        tx.oncomplete = () => resolve();
      });
    for (const id of ['invalid', 'replaced']) {
      await put(id, { schemaVersion: 999 });
      try {
        await s.loadWorkspaceCreationDraft(id);
      } catch {
        /* expected malformed record */
      }
    }
    const unreadable = s.getWorkspaceCreationDraftSnapshot('invalid').hasUnreadableDraft;
    await put('replaced', { ...s.createWorkspaceCreationDraft(), prompt: 'Concurrent' });
    await s.discardWorkspaceCreationDraft('invalid');
    await s.discardWorkspaceCreationDraft('replaced');
    db.close();
    return { unreadable, replacement: s.getWorkspaceCreationDraftSnapshot('replaced').draft };
  });
  expect(result.unreadable).toBe(true);
  expect(result.replacement).toMatchObject({ prompt: 'Concurrent' });
  await page.reload();
  const drafts = await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    return Promise.all(['invalid', 'replaced'].map((id) => s.loadWorkspaceCreationDraft(id)));
  });
  expect(drafts[0]).toBeNull();
  expect(drafts[1]).toMatchObject({ prompt: 'Concurrent' });
});

test('preserves a valid disk revision written by another window during clear', async ({ page }) => {
  await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('concurrent', {
      ...s.createWorkspaceCreationDraft(),
      revision: 'owned',
    });
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(
        s.WORKSPACE_DRAFT_DATABASE_NAME,
        s.WORKSPACE_DRAFT_DATABASE_VERSION
      );
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(s.WORKSPACE_DRAFT_STORE_NAME, 'readwrite');
      tx.objectStore(s.WORKSPACE_DRAFT_STORE_NAME).put(
        {
          ...s.createWorkspaceCreationDraft(),
          revision: 'other-window',
          prompt: 'Keep concurrent',
        },
        'concurrent'
      );
      tx.oncomplete = () => resolve();
    });
    db.close();
    await s.clearWorkspaceCreationDraft('concurrent', 'owned');
  });
  await page.reload();
  expect(
    await page.evaluate(async () =>
      (await window.loadDraftStorage()).loadWorkspaceCreationDraft('concurrent')
    )
  ).toMatchObject({ prompt: 'Keep concurrent' });
});

test('retains the unsaved-edit warning when clearing an older submission', async ({ page }) => {
  const warning = await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('warning', {
      ...s.createWorkspaceCreationDraft(),
      revision: 'submitted',
    });
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
    try {
      await s.saveWorkspaceCreationDraft('warning', {
        ...s.createWorkspaceCreationDraft(),
        revision: 'newer',
        prompt: 'Unsaved',
      });
    } catch (error) {
      if (!String(error).includes('could not be saved')) {
        throw error;
      }
    }
    await s.clearWorkspaceCreationDraft('warning', 'submitted');
    return s.getWorkspaceCreationDraftSnapshot('warning').persistenceError;
  });
  expect(warning).toContain('could not be saved');
});

test('unreadable discard preserves a new draft lifecycle started while deletion is queued', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('seed', s.createWorkspaceCreationDraft());
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(
        s.WORKSPACE_DRAFT_DATABASE_NAME,
        s.WORKSPACE_DRAFT_DATABASE_VERSION
      );
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(s.WORKSPACE_DRAFT_STORE_NAME, 'readwrite');
      tx.objectStore(s.WORKSPACE_DRAFT_STORE_NAME).put({ schemaVersion: 999 }, 'discard-race');
      tx.oncomplete = () => resolve();
    });
    db.close();
    try {
      await s.loadWorkspaceCreationDraft('discard-race');
    } catch (error) {
      if (!String(error).includes('could not be restored')) {
        throw error;
      }
    }
    const discard = s.discardWorkspaceCreationDraft('discard-race');
    const save = s.saveWorkspaceCreationDraft('discard-race', {
      ...s.createWorkspaceCreationDraft(),
      prompt: 'New lifecycle',
    });
    const generation = s.getWorkspaceCreationDraftSnapshot('discard-race').generation;
    await Promise.all([discard, save]);
    return { generation, snapshot: s.getWorkspaceCreationDraftSnapshot('discard-race') };
  });
  expect(result.snapshot.generation).toBe(result.generation);
  expect(result.snapshot.draft).toMatchObject({ prompt: 'New lifecycle' });
});

test('retains a pending submitted fallback while newer writes fail', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const s = await window.loadDraftStorage();
    await s.saveWorkspaceCreationDraft('pinned', {
      ...s.createWorkspaceCreationDraft(),
      revision: 'persisted',
    });
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
    const failedEdit = async (revision: string) => {
      try {
        await s.saveWorkspaceCreationDraft('pinned', {
          ...s.createWorkspaceCreationDraft(),
          revision,
          prompt: revision,
        });
      } catch (error) {
        if (!String(error).includes('could not be saved')) {
          throw error;
        }
      }
    };
    await failedEdit('submitted');
    const release = s.pinWorkspaceCreationDraft('pinned', 'submitted');
    for (let index = 0; index < 20; index++) {
      await failedEdit(`newer-${index}`);
    }
    await s.clearWorkspaceCreationDraft('pinned', 'submitted');
    release();
    return s.getWorkspaceCreationDraftSnapshot('pinned').draft;
  });
  expect(result).toMatchObject({ prompt: 'newer-19' });
  await page.reload();
  expect(
    await page.evaluate(async () =>
      (await window.loadDraftStorage()).loadWorkspaceCreationDraft('pinned')
    )
  ).toBeNull();
});
