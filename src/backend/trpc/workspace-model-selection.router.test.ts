import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceCoreRouter } from './workspace.trpc';

function fixture() {
  const graph = createFakeApplicationGraph('workspace-model-router');
  const launch = vi
    .fn()
    .mockResolvedValue({ workspace: { id: 'workspace' }, defaultSessionId: 'session' });
  const appContext = {
    ...graph,
    services: { ...graph.services, launchWorkspace: launch },
  } satisfies AppContext;
  const caller = workspaceCoreRouter.createCaller({ appContext });
  return { launch, caller };
}

describe('manual workspace model selection', () => {
  it('preserves and trims the selected model at the creation boundary', async () => {
    const f = fixture();
    const source = {
      type: 'MANUAL' as const,
      projectId: 'project',
      name: 'Workspace',
      provider: 'CODEX' as const,
      model: '  gpt-6-luna  ',
    };
    expect(await f.caller.create(source)).toEqual({ id: 'workspace' });
    expect(f.launch).toHaveBeenCalledExactlyOnceWith({ ...source, model: 'gpt-6-luna' });
  });

  it('preserves explicit native thinking and Plan off at the workspace boundary', async () => {
    const f = fixture();
    const source = {
      type: 'MANUAL' as const,
      projectId: 'project',
      name: 'Workspace',
      provider: 'CLAUDE' as const,
      reasoningEffort: null,
      planModeEnabled: false,
    };
    await f.caller.create(source);
    expect(f.launch).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('rejects an empty explicit model before launching', async () => {
    const f = fixture();
    await expect(
      f.caller.create(
        unsafeCoerce({ type: 'MANUAL', projectId: 'project', name: 'Workspace', model: '  ' })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('leaves an omitted model available for provider-specific default resolution', async () => {
    const f = fixture();
    const source = {
      type: 'MANUAL' as const,
      projectId: 'project',
      name: 'Workspace',
      provider: 'CLAUDE' as const,
    };
    await f.caller.create(source);
    expect(f.launch).toHaveBeenCalledExactlyOnceWith(source);
  });
});
