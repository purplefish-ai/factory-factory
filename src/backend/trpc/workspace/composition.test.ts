import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeRouters } from '../trpc';
import { workspaceRouter } from '../workspace.trpc';

describe('workspace router composition', () => {
  it('uses the supported merge API without reading internal procedure definitions', () => {
    const workspaceRouterSource = readFileSync(
      new URL('../workspace.trpc.ts', import.meta.url),
      'utf8'
    );

    expect(mergeRouters).toBeTypeOf('function');
    expect(workspaceRouterSource).not.toContain('_def.procedures');
  });

  it('keeps core, child-workspace, and file procedures on the flat workspace router', () => {
    expect(workspaceRouter.get).toBeTypeOf('function');
    expect(workspaceRouter.sendMessageToParent).toBeTypeOf('function');
    expect(workspaceRouter.sendMessageToChild).toBeTypeOf('function');
    expect(workspaceRouter.readFile).toBeTypeOf('function');
  });
});
