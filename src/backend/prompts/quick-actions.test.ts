import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearQuickActionCache,
  getQuickAction,
  getQuickActionContent,
  listQuickActions,
  listQuickActionsForRepo,
} from './quick-actions';

describe('quick-actions', () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    clearQuickActionCache();
  });

  afterEach(() => {
    clearQuickActionCache();
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads built-in session bar quick actions and resolves content by id', () => {
    const actions = listQuickActions();
    expect(actions.length).toBeGreaterThan(0);

    const rename = getQuickAction('rename-branch');
    expect(rename).toMatchObject({
      id: 'rename-branch',
      mode: 'newSession',
      surface: 'sessionBar',
      name: 'Rename Branch',
    });
    expect(getQuickActionContent('rename-branch')).toContain('rename the current branch');
    expect(getQuickAction('does-not-exist')).toBeNull();
    expect(getQuickActionContent('does-not-exist')).toBeNull();
  });

  it('resolves repo quick actions from factory-factory.json with overrides', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-repo-'));
    cleanupDirs.push(repoDir);

    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          scripts: {},
          quickActions: {
            includeDefaults: {
              sessionBar: true,
              chatBar: false,
            },
            actions: [
              {
                id: 'review',
                path: '.factory-factory/actions/review.md',
                pinned: true,
                icon: 'eye',
              },
              {
                id: 'fetch-rebase',
                enabled: false,
              },
              {
                id: 'inline-help',
                path: '.factory-factory/actions/inline-help.md',
                surface: 'chatBar',
                mode: 'sendPrompt',
              },
              {
                id: 'brief-help',
                path: '.factory-factory/actions/brief-help.md',
                mode: 'sendPrompt',
              },
              {
                id: 'mismatch-help',
                path: '.factory-factory/actions/mismatch-help.md',
                surface: 'chatBar',
              },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    mkdirSync(join(repoDir, '.factory-factory/actions'), { recursive: true });

    writeFileSync(
      join(repoDir, '.factory-factory/actions/review.md'),
      `---
name: Review
description: Review recent changes
---
Please review the recent changes in this workspace.`,
      'utf8'
    );

    writeFileSync(
      join(repoDir, '.factory-factory/actions/inline-help.md'),
      `---
name: Inline Help
description: Ask for focused help
---
Give me a short plan for the next changes.`,
      'utf8'
    );

    writeFileSync(
      join(repoDir, '.factory-factory/actions/brief-help.md'),
      `---
name: Brief Help
description: Ask for concise guidance
---
Give me the shortest next step list for this branch.`,
      'utf8'
    );

    writeFileSync(
      join(repoDir, '.factory-factory/actions/mismatch-help.md'),
      `---
name: Mismatch Help
description: Intentionally mismatched mode and surface
mode: newSession
---
Summarize what should be fixed before merge.`,
      'utf8'
    );

    const sessionBarActions = await listQuickActionsForRepo({
      repoPath: repoDir,
      surface: 'sessionBar',
    });
    const chatBarActions = await listQuickActionsForRepo({
      repoPath: repoDir,
      surface: 'chatBar',
    });

    expect(sessionBarActions.some((action) => action.id === 'fetch-rebase')).toBe(false);
    expect(sessionBarActions.find((action) => action.id === 'review')).toMatchObject({
      id: 'review',
      pinned: true,
      icon: 'eye',
      mode: 'newSession',
      surface: 'sessionBar',
    });
    expect(chatBarActions).toEqual([
      expect.objectContaining({
        id: 'inline-help',
        mode: 'sendPrompt',
        surface: 'chatBar',
      }),
      expect.objectContaining({
        id: 'brief-help',
        mode: 'sendPrompt',
        surface: 'chatBar',
      }),
      expect.objectContaining({
        id: 'mismatch-help',
        mode: 'sendPrompt',
        surface: 'chatBar',
      }),
    ]);
  });
});
