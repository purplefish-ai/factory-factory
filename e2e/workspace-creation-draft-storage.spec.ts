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
      await Promise.all([first, clear, late]);
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
