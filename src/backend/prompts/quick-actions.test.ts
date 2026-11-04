import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREATE_PULL_REQUEST_QUICK_ACTION_ID } from '@/shared/quick-actions';
import {
  clearQuickActionCache,
  getQuickAction,
  getQuickActionContent,
  listQuickActions,
} from './quick-actions';

function writeQuickActionFile(id: string, content: string): string {
  const filePath = join(process.cwd(), 'prompts', 'quick-actions', `${id}.md`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('quick-actions', () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    clearQuickActionCache();
  });

  afterEach(() => {
    clearQuickActionCache();
    for (const filePath of cleanupPaths.splice(0)) {
      rmSync(filePath, { force: true });
    }
  });

  it('loads repository quick actions and resolves content by id', () => {
    const actions = listQuickActions();
    expect(actions.length).toBeGreaterThan(0);

    const rename = getQuickAction('rename-branch');
    expect(rename).toMatchObject({
      id: 'rename-branch',
      type: 'agent',
      name: 'Rename Branch',
    });
    expect(getQuickActionContent('rename-branch')).toContain('rename the current branch');
    expect(getQuickAction('does-not-exist')).toBeNull();
    expect(getQuickActionContent('does-not-exist')).toBeNull();
  });

  it('ships the quick actions the client offers outside the menu, once each', () => {
    const actions = listQuickActions();
    expect(getQuickAction(CREATE_PULL_REQUEST_QUICK_ACTION_ID)).toMatchObject({
      type: 'agent',
      name: 'Create Pull Request',
    });
    expect(getQuickActionContent(CREATE_PULL_REQUEST_QUICK_ACTION_ID)).toContain('gh');
    // The composer used to keep its own copies; the catalog is now the only source.
    const names = actions.map((action) => action.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.includes('pull request'))).toEqual(['create pull request']);
  });

  it('parses script quick actions without content', () => {
    const id = `script-test-${Date.now()}`;
    cleanupPaths.push(
      writeQuickActionFile(
        id,
        `---\nname: Script Test\ndescription: runs script\ntype: script\nscript: pnpm test\n---\nignored body`
      )
    );

    clearQuickActionCache();
    const action = getQuickAction(id);

    expect(action).toMatchObject({
      id,
      type: 'script',
      script: 'pnpm test',
      content: undefined,
    });
    expect(getQuickActionContent(id)).toBeNull();
  });

  it('defaults unknown type to agent', () => {
    const id = `unknown-type-${Date.now()}`;
    cleanupPaths.push(
      writeQuickActionFile(
        id,
        `---\nname: Unknown\ntype: robot\ndescription: fallback\n---\nUse fallback content`
      )
    );

    clearQuickActionCache();
    const action = getQuickAction(id);

    expect(action).toMatchObject({
      id,
      type: 'agent',
      content: 'Use fallback content',
    });
  });
});
