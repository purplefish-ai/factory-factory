import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
    mockLoggerWarn.mockClear();
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

  it('skips loading repo markdown for disabled actions', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-disabled-'));
    cleanupDirs.push(repoDir);

    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          quickActions: {
            actions: [
              {
                id: 'create-pr',
                path: '.factory-factory/actions/missing.md',
                enabled: false,
              },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const actions = await listQuickActionsForRepo({
      repoPath: repoDir,
      surface: 'chatBar',
    });

    expect(actions.some((action) => action.id === 'create-pr')).toBe(false);
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      'Failed to load repo quick action markdown',
      expect.anything()
    );
  });

  it('propagates invalid factory-factory.json errors instead of silently using defaults', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-invalid-config-'));
    cleanupDirs.push(repoDir);

    writeFileSync(join(repoDir, 'factory-factory.json'), '{ invalid json', 'utf8');

    await expect(
      listQuickActionsForRepo({
        repoPath: repoDir,
        surface: 'chatBar',
      })
    ).rejects.toThrow(/Invalid JSON/);
  });

  it('rejects repo quick action paths that escape the repository through symlinks', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-symlink-repo-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'quick-actions-symlink-external-'));
    cleanupDirs.push(repoDir, externalDir);

    mkdirSync(join(repoDir, '.factory-factory/actions'), { recursive: true });
    writeFileSync(
      join(externalDir, 'escape.md'),
      `---
name: Escape
description: Outside repo
---
This should never be loaded.`,
      'utf8'
    );
    symlinkSync(
      join(externalDir, 'escape.md'),
      join(repoDir, '.factory-factory/actions/escape.md')
    );
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          quickActions: {
            includeDefaults: false,
            actions: [
              {
                id: 'escape',
                path: '.factory-factory/actions/escape.md',
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

    const actions = await listQuickActionsForRepo({
      repoPath: repoDir,
      surface: 'chatBar',
    });

    expect(actions).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Ignoring quick action path outside repository',
      expect.objectContaining({
        repoPath: repoDir,
        actionPath: '.factory-factory/actions/escape.md',
      })
    );
  });

  it('keeps configured ordering separate for identical ids on different surfaces', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-ordering-'));
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.factory-factory/actions'), { recursive: true });
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          quickActions: {
            includeDefaults: false,
            actions: [
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-session.md',
                surface: 'sessionBar',
              },
              {
                id: 'review',
                path: '.factory-factory/actions/review.md',
                surface: 'sessionBar',
              },
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-chat.md',
                surface: 'chatBar',
              },
              {
                id: 'brief-help',
                path: '.factory-factory/actions/brief-help.md',
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

    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-session.md'),
      `---
name: Shared Session
---
Session action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/review.md'),
      `---
name: Review
---
Review action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-chat.md'),
      `---
name: Shared Chat
---
Chat action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/brief-help.md'),
      `---
name: Brief Help
---
Help action.`,
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

    expect(sessionBarActions.map((action) => action.id)).toEqual(['shared', 'review']);
    expect(chatBarActions.map((action) => action.id)).toEqual(['shared', 'brief-help']);
  });

  it('preserves the other surface when replacing an action without an explicit surface', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-surface-replace-'));
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.factory-factory/actions'), { recursive: true });
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          quickActions: {
            includeDefaults: false,
            actions: [
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-session.md',
                surface: 'sessionBar',
              },
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-chat.md',
                surface: 'chatBar',
              },
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-chat-override.md',
              },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-session.md'),
      `---
name: Shared Session
surface: sessionBar
---
Session action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-chat.md'),
      `---
name: Shared Chat
surface: chatBar
---
Original chat action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-chat-override.md'),
      `---
name: Shared Chat Override
surface: chatBar
---
Updated chat action.`,
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

    expect(sessionBarActions).toEqual([
      expect.objectContaining({
        id: 'shared',
        surface: 'sessionBar',
        content: 'Session action.',
      }),
    ]);
    expect(chatBarActions).toEqual([
      expect.objectContaining({
        id: 'shared',
        surface: 'chatBar',
        content: 'Updated chat action.',
      }),
    ]);
  });

  it('preserves the other surface when disabling an action without an explicit surface', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'quick-actions-surface-disable-'));
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.factory-factory/actions'), { recursive: true });
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          quickActions: {
            includeDefaults: false,
            actions: [
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-session.md',
                surface: 'sessionBar',
              },
              {
                id: 'shared',
                path: '.factory-factory/actions/shared-chat.md',
                surface: 'chatBar',
              },
              {
                id: 'shared',
                mode: 'sendPrompt',
                enabled: false,
              },
            ],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-session.md'),
      `---
name: Shared Session
surface: sessionBar
---
Session action.`,
      'utf8'
    );
    writeFileSync(
      join(repoDir, '.factory-factory/actions/shared-chat.md'),
      `---
name: Shared Chat
surface: chatBar
---
Original chat action.`,
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

    expect(sessionBarActions).toEqual([
      expect.objectContaining({
        id: 'shared',
        surface: 'sessionBar',
        content: 'Session action.',
      }),
    ]);
    expect(chatBarActions).toEqual([]);
  });
});
