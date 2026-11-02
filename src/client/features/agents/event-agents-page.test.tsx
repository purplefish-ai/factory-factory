// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { managedAgentSchema, agentSavedUpdateSchema } from '@/shared/agent-management';
import { agentDraftValidationSchema } from '@/shared/agent-validation';
import { waitForReact } from '@/test-utils/react-act';
import { AgentsPage } from './agents-page';
import { eventAgentFixture, eventSummaryFixture } from './event-agent.test-support';

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let saved = eventAgentFixture();
let requests: Array<{ path: string; input: unknown; type: string }>;
let fail: string | undefined;
let saveWait: Promise<void> | undefined;
let previewWait: Promise<void> | undefined;
let sourceWait: Promise<void> | undefined;
let listWait: Promise<void> | undefined;
let archived: boolean;
let sameRailId: boolean;
let nativePreview: typeof preview;
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const preview = agentDraftValidationSchema.parse({
  triggers: [
    {
      index: 0,
      triggerId: 'saved-event:github',
      capability: { status: 'SUPPORTED', reasonCode: 'SUPPORTED', explanation: 'Supported event' },
    },
  ],
  execution: {
    status: 'VALIDATED',
    intent: {
      version: 1,
      provider: 'CLAUDE',
      model: 'confirmed-model',
      requestedModel: 'requested-model',
      reasoningEffort: null,
      providerIntent: 'INHERITED',
      modelIntent: 'INHERITED',
      effortIntent: 'INHERITED',
      effortNormalization: 'INHERITED_TO_NATIVE_DEFAULT',
    },
  },
});
function Harness() {
  const { slug } = useParams();
  const location = useLocation();
  const project = {
    id: slug === 'other' ? 'other' : 'owner',
    slug: slug ?? 'owner',
    name: 'Project',
    isArchived: archived,
  };
  return (
    <>
      <Link to="/projects/owner/agents/same">Scheduled same ID</Link>
      <Link to="/projects/owner/agents/same?kind=event">Event same ID</Link>
      <Link to="/projects/other/agents/same?kind=event">Other project</Link>
      <AgentsPage project={project} />
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
function getEvent(input: unknown) {
  if (fail === 'agent.get') {
    throw new Error('Saved read unavailable');
  }
  const args = z
    .object({ agentId: z.string(), projectId: z.string(), retainedCursor: z.string().optional() })
    .parse(input);
  if (args.agentId === 'missing') {
    throw new TRPCClientError('Missing', {
      result: {
        error: { message: 'Missing', code: -32_004, data: { code: 'NOT_FOUND', httpStatus: 404 } },
      },
    });
  }
  if (args.retainedCursor) {
    return {
      ...saved,
      projectId: args.projectId,
      retainedTriggers: [
        { ...saved.configuredTriggers[0], id: 'retained-tail', isConfigured: false },
      ],
      retainedNextCursor: null,
    };
  }
  return { ...saved, id: args.agentId, projectId: args.projectId };
}
async function listEvents(input: unknown) {
  await listWait;
  if (fail === 'agent.list') {
    throw new Error('Event list unavailable');
  }
  const args = z.object({ projectId: z.string(), cursor: z.string().optional() }).parse(input);
  return args.cursor
    ? {
        items: [{ ...eventSummaryFixture(saved), id: 'page-two', projectId: args.projectId }],
        nextCursor: null,
      }
    : {
        items: [
          {
            ...eventSummaryFixture(saved),
            id: sameRailId ? 'same' : 'rail-first',
            projectId: args.projectId,
          },
        ],
        nextCursor: 'list-next',
      };
}
async function respond(path: string, input: unknown) {
  if (path === 'agent.list') {
    return listEvents(input);
  }
  if (path === 'agent.get') {
    return getEvent(input);
  }
  if (path === 'agent.updateSaved') {
    await saveWait;
    const args = agentSavedUpdateSchema.parse(input);
    if (args.expectedManagementRevision !== saved.managementRevision) {
      throw new TRPCClientError(
        'The saved definition changed. Review your edits before reloading.',
        {
          result: {
            error: {
              message: 'Saved definition changed',
              code: -32_009,
              data: { code: 'CONFLICT', httpStatus: 409 },
            },
          },
        }
      );
    }
    saved = managedAgentSchema.parse({
      ...saved,
      name: args.specification.name,
      instructions: args.specification.instructions,
      executionConfig: args.specification.executionConfig,
      specification: args.specification,
      managementRevision: saved.managementRevision + 1,
    });
    return saved;
  }
  if (path === 'agent.validateDraft') {
    await previewWait;
    return nativePreview;
  }
  if (path === 'agent.projectSources') {
    await sourceWait;
    return {
      project: { id: 'owner', name: 'Project' },
      slack: { connections: [] },
      github: { error: 'GitHub access unavailable' },
    };
  }
  if (path.endsWith('navigationSummary')) {
    return { totalCount: 1, failedCount: 0 };
  }
  if (path === 'periodicTask.list') {
    return [scheduled()];
  }
  if (path === 'periodicTask.get') {
    return scheduled();
  }
  if (path === 'periodicTask.listExecutions') {
    return [];
  }
  throw new Error(`Unexpected ${path}`);
}
function scheduled() {
  return {
    id: 'same',
    projectId: 'owner',
    name: 'Scheduled control',
    prompt: 'Scheduled instructions',
    cadence: 'DAILY',
    scheduledTime: null,
    timezone: null,
    scheduledDayOfMonth: null,
    isEnabled: true,
    nextRunAt: new Date(),
    lastRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    executions: [],
  };
}
async function render(path = '/projects/owner/agents/same?kind=event') {
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input, type: op.type });
            void respond(op.path, op.input).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error) => observer.error(TRPCClientError.from(error))
            );
          }),
    ],
  });
  await act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/projects/:slug/agents/:id?" element={<Harness />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) {
    throw new Error(`Missing button ${text}`);
  }
  return found;
}
async function click(text: string) {
  await act(() => button(text).click());
}
async function navigate(text: string) {
  await act(() =>
    [...container.querySelectorAll('a')]
      .find((item) => item.textContent === text)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  );
}
async function edit(selector: string, value: string) {
  const input = container.querySelector(selector);
  if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) {
    throw new Error(`Missing ${selector}`);
  }
  await act(() => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      'value'
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved = { ...eventAgentFixture(), id: 'same' };
  requests = [];
  fail = undefined;
  saveWait = undefined;
  previewWait = undefined;
  sourceWait = undefined;
  listWait = undefined;
  archived = false;
  sameRailId = false;
  nativePreview = preview;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});
it('opens an event outside page one, keeps equal IDs distinct and separates list and retained continuation', async () => {
  saved.retainedNextCursor = 'retained-next';
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  expect(
    requests.some(
      (item) => item.path === 'periodicTask.get' || item.path === 'periodicTask.listExecutions'
    )
  ).toBe(false);
  expect(container.textContent).not.toContain('Next run');
  expect(
    [...container.querySelectorAll('main button')].map((item) => item.textContent)
  ).not.toContain('Delete');
  await click('Load more event agents');
  await waitForReact(() =>
    expect(
      container.querySelector('a[href="/projects/owner/agents/page-two?kind=event"]')
    ).not.toBeNull()
  );
  await click('Load more retained triggers');
  await waitForReact(() => expect(container.textContent).toContain('retained-tail'));
  expect(requests).toContainEqual(
    expect.objectContaining({
      path: 'agent.get',
      input: { projectId: 'owner', agentId: 'same', retainedCursor: 'retained-next' },
    })
  );
  await navigate('Scheduled same ID');
  await waitForReact(() =>
    expect(container.querySelector('h2')?.textContent).toBe('Scheduled control')
  );
  expect(requests.some((item) => item.path === 'periodicTask.listExecutions')).toBe(true);
});
it.each(['?kind=', '?kind=other', '?kind=event&kind=scheduled', '?kind=event&kind=event'])(
  'rejects explicit invalid kinds %s without owner queries',
  async (search) => {
    await render(`/projects/owner/agents/same${search}`);
    expect(container.textContent).toContain('Invalid agent kind');
    expect(requests).toHaveLength(0);
  }
);
it('preserves a conflicted draft and original CAS through refresh, then reloads deliberately', async () => {
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  await edit('textarea[aria-label="Instructions"]', 'Unsaved draft');
  saved = {
    ...saved,
    managementRevision: 3,
    name: 'Concurrent cosmetic edit',
    specification: { ...saved.specification!, name: 'Concurrent cosmetic edit' },
  };
  await submit();
  await waitForReact(() => expect(container.textContent).toContain('saved definition changed'));
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')?.value
  ).toBe('Unsaved draft');
  await submit();
  expect(
    requests
      .filter((item) => item.path === 'agent.updateSaved')
      .map((item) => agentSavedUpdateSchema.parse(item.input).expectedManagementRevision)
  ).toEqual([2, 2]);
  await click('Discard edits and reload saved configuration');
  expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
    'Concurrent cosmetic edit'
  );
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')?.value
  ).toBe(saved.instructions);
});
it('keeps the draft across a read failure and later success without advancing its baseline', async () => {
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  await edit('input[name="name"]', 'Typed name');
  const form = container.querySelector('form');
  fail = 'agent.get';
  await act(() => queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.agent.get) }));
  expect(container.querySelector('form')).toBe(form);
  await waitForReact(() => expect(container.textContent).toContain('draft is preserved'));
  fail = undefined;
  saved.managementRevision = 9;
  await act(() => queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.agent.get) }));
  expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Typed name');
  await submit();
  expect(
    agentSavedUpdateSchema.parse(requests.find((item) => item.path === 'agent.updateSaved')?.input)
      .expectedManagementRevision
  ).toBe(2);
});
it('serializes save and invalidates the captured owner after switching kind, project and editing session', async () => {
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  const gate = deferred();
  saveWait = gate.promise;
  await edit('input[name="name"]', 'Captured old edit');
  await submit();
  await submit();
  expect(requests.filter((item) => item.path === 'agent.updateSaved')).toHaveLength(1);
  queryClient.setQueryData(
    getQueryKey(
      trpc.agent.get,
      { projectId: 'owner', agentId: 'same', retainedCursor: 'cached-tail' },
      'query'
    ),
    saved
  );
  await navigate('Other project');
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  await edit('input[name="name"]', 'New project draft');
  await act(() => gate.resolve());
  await waitForReact(() =>
    expect(
      queryClient.getQueryState(
        getQueryKey(
          trpc.agent.get,
          { projectId: 'owner', agentId: 'same', retainedCursor: 'cached-tail' },
          'query'
        )
      )?.isInvalidated
    ).toBe(true)
  );
  expect(container.querySelector('form')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
    'New project draft'
  );
  expect(container.querySelector('output')?.textContent).toContain('/other/');
});
it('validates only by explicit mutation and keeps inherited settings through preview and save', async () => {
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  expect(
    requests.some(
      (item) => item.path === 'agent.projectSources' || item.path === 'agent.validateDraft'
    )
  ).toBe(false);
  await click('Edit Agent');
  await click('Validate draft');
  await waitForReact(() => expect(container.textContent).toContain('confirmed-model'));
  expect(container.textContent).toContain('requested-model');
  expect(container.textContent).toContain('INHERITED_TO_NATIVE_DEFAULT');
  expect(container.textContent).toContain('None (null)');
  expect(requests.find((item) => item.path === 'agent.validateDraft')?.type).toBe('mutation');
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Execution settings"]')?.value
  ).toBe('{\n  "version": 1\n}');
  await edit('input[name="name"]', 'Preview is stale now');
  expect(container.querySelector('[aria-label="Draft preview"]')).toBeNull();
  await submit();
  await waitForReact(() => expect(container.querySelector('form')).toBeNull());
  expect(
    agentSavedUpdateSchema.parse(requests.find((item) => item.path === 'agent.updateSaved')?.input)
      .specification.executionConfig
  ).toEqual({ version: 1 });
});
it.each(['preview', 'sources'])(
  'drops late %s feedback after a draft edit and kind switch',
  async (kind) => {
    await render();
    await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
    await click('Edit Agent');
    const gate = deferred();
    if (kind === 'preview') {
      previewWait = gate.promise;
    } else {
      sourceWait = gate.promise;
    }
    await click(kind === 'preview' ? 'Validate draft' : 'Refresh project sources');
    await edit('input[name="name"]', 'Newer draft');
    await act(() => gate.resolve());
    expect(container.querySelector('[aria-label="Draft preview"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project sources"]')).toBeNull();
    await navigate('Scheduled same ID');
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Scheduled control')
    );
    expect(container.textContent).not.toContain('confirmed-model');
  }
);
it('requires an explicit blank complete replacement for unknown or invalid stored data', async () => {
  saved = {
    ...saved,
    configurationMembership: 'UNKNOWN',
    specification: null,
    executionConfig: null,
    configuredTriggers: [],
    retainedTriggers: [
      { ...saved.configuredTriggers[0]!, isConfigured: null, configuration: null },
    ],
  };
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('Exact membership is unknown');
  await click('Replace complete specification');
  const json = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Full saved specification JSON"]'
  );
  expect(json?.value).toBe('');
  await submit();
  expect(requests.some((item) => item.path === 'agent.updateSaved')).toBe(false);
  await edit(
    'textarea[aria-label="Full saved specification JSON"]',
    JSON.stringify(eventAgentFixture().specification)
  );
  await submit();
  await waitForReact(() =>
    expect(requests.some((item) => item.path === 'agent.updateSaved')).toBe(true)
  );
});
it('keeps archived details readable with writes disabled and missing IDs explicit', async () => {
  archived = true;
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  expect(button('Edit Agent').disabled).toBe(true);
  expect(button('Create Agent').disabled).toBe(true);
});
it('does not auto-select or claim empty when either initial list fails', async () => {
  fail = 'agent.list';
  await render('/projects/owner/agents');
  await waitForReact(() => expect(container.textContent).toContain('Event list unavailable'));
  expect(container.querySelector('output')?.textContent).toBe('/projects/owner/agents');
  expect(container.textContent).not.toContain('No agents in this project.');
});

it('keeps same-ID rail highlights and drafts distinct between kinds', async () => {
  sameRailId = true;
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  expect(container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(
    '/projects/owner/agents/same?kind=event'
  );
  await click('Edit Agent');
  await edit('input[name="name"]', 'Event only draft');
  await navigate('Scheduled same ID');
  await waitForReact(() =>
    expect(container.querySelector('h2')?.textContent).toBe('Scheduled control')
  );
  expect(container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(
    '/projects/owner/agents/same'
  );
  await click('Edit Agent');
  expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
    'Scheduled control'
  );
});
it('keeps an explicit missing event selected without scheduled fallback', async () => {
  await render('/projects/owner/agents/missing?kind=event');
  await waitForReact(() =>
    expect(container.textContent).toContain('Agent not found in this project')
  );
  expect(container.querySelector('output')?.textContent).toContain('/missing?kind=event');
  expect(requests.some((request) => request.path === 'periodicTask.get')).toBe(false);
});
it.each(['UNSUPPORTED', 'UNAVAILABLE'] as const)(
  'renders %s preview independently of save authority',
  async (status) => {
    nativePreview = {
      triggers: [],
      execution:
        status === 'UNSUPPORTED'
          ? {
              status,
              reasonCode: 'UNSUPPORTED_REASONING_EFFORT',
              explanation: 'Explicit effort is unsupported.',
            }
          : {
              status,
              reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
              explanation: 'Native options unavailable.',
            },
    };
    await render();
    await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
    await click('Edit Agent');
    await edit(
      'textarea[aria-label="Execution settings"]',
      '{"version":1,"provider":"CODEX","model":"gpt-test","reasoningEffort":"high"}'
    );
    await click('Validate draft');
    await waitForReact(() =>
      expect(container.querySelector('[aria-label="Draft preview"]')?.textContent).toContain(status)
    );
    expect(button('Save changes').disabled).toBe(false);
    await submit();
    await waitForReact(() => expect(container.querySelector('form')).toBeNull());
  }
);
it.each(['preview', 'sources'])(
  'drops a pending %s response after switching kind and starting a new editing session',
  async (kind) => {
    await render();
    await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
    await click('Edit Agent');
    const gate = deferred();
    if (kind === 'preview') {
      previewWait = gate.promise;
    } else {
      sourceWait = gate.promise;
    }
    await click(kind === 'preview' ? 'Validate draft' : 'Refresh project sources');
    await navigate('Scheduled same ID');
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Scheduled control')
    );
    await click('Edit Agent');
    await edit('input[name="name"]', 'New scheduled session');
    await act(() => gate.resolve());
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'New scheduled session'
    );
    expect(container.querySelector('[aria-label="Draft preview"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project sources"]')).toBeNull();
  }
);
it('does not unlock a pending save when an earlier preview finishes', async () => {
  await render();
  await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
  await click('Edit Agent');
  const previewGate = deferred();
  previewWait = previewGate.promise;
  await click('Validate draft');
  const saveGate = deferred();
  saveWait = saveGate.promise;
  await submit();
  await act(() => previewGate.resolve());
  expect(
    container.querySelector<HTMLInputElement>('input[name="name"]')?.matches(':disabled')
  ).toBe(true);
  await submit();
  expect(requests.filter((request) => request.path === 'agent.updateSaved')).toHaveLength(1);
  await act(() => saveGate.resolve());
  await waitForReact(() => expect(container.querySelector('form')).toBeNull());
});

it.each(['preview', 'sources'])(
  'preserves newer same-draft %s feedback when an older request fails late',
  async (kind) => {
    await render();
    await waitForReact(() => expect(container.querySelector('h2')?.textContent).toBe(saved.name));
    await click('Edit Agent');
    const older = deferred();
    if (kind === 'preview') {
      previewWait = older.promise;
    } else {
      sourceWait = older.promise;
    }
    await click(kind === 'preview' ? 'Validate draft' : 'Refresh project sources');
    const newer = deferred();
    if (kind === 'preview') {
      previewWait = newer.promise;
    } else {
      sourceWait = newer.promise;
    }
    await click(kind === 'preview' ? 'Validate draft' : 'Refresh project sources');
    await act(() => newer.resolve());
    const selector =
      kind === 'preview' ? '[aria-label="Draft preview"]' : '[aria-label="Project sources"]';
    await waitForReact(() => expect(container.querySelector(selector)).not.toBeNull());
    const current = container.querySelector(selector)?.textContent;
    await act(() => older.reject(new Error('Older request failed after current feedback')));
    expect(container.querySelector(selector)?.textContent).toBe(current);
    expect(container.textContent).not.toContain('Older request failed after current feedback');
  }
);
