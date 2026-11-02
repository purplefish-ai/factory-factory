// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { managedTriggerSchema } from '@/shared/agent-management';
import { agentProjectSourcesSchema } from '@/shared/agent-validation';
import { waitForReact } from '@/test-utils/react-act';
import { EventAgentInspection } from './event-agent-detail';
import { EventAgentEditor } from './event-agent-editor';
import { RetainedContinuation } from './event-agent-selection';
import { eventAgentFixture } from './event-agent.test-support';
import type { EventAgent } from './types';

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function button(text: string) {
  const node = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!node) {
    throw new Error(`Missing button ${text}`);
  }
  return node;
}
async function click(text: string) {
  await act(() => button(text).click());
}
async function edit(selector: string, value: string) {
  const field = container.querySelector(selector);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`Missing field ${selector}`);
  }
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(children: ReactNode) {
  await act(() => root.render(children));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});
function sources(connection = 'A', cursor?: string) {
  const channels =
    cursor === 'page-2'
      ? [
          { id: `${connection}-shared`, name: `${connection} shared` },
          { id: `${connection}-two`, name: `${connection} two` },
        ]
      : cursor === 'page-3'
        ? [{ id: `${connection}-three`, name: `${connection} three` }]
        : [
            { id: `${connection}-one`, name: `${connection} one` },
            { id: `${connection}-shared`, name: `${connection} shared` },
          ];
  return agentProjectSourcesSchema.parse({
    project: { id: 'owner', name: 'Owner' },
    slack: {
      connections: [],
      channels,
      nextCursor: cursor === 'page-3' ? null : cursor === 'page-2' ? 'page-3' : 'page-2',
    },
    github: { error: 'GitHub unavailable in fixture' },
  });
}
const noSave = () => Promise.resolve();
const noPreview = () =>
  Promise.resolve({
    triggers: [],
    execution: {
      status: 'UNAVAILABLE' as const,
      reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE' as const,
      explanation: 'Fixture only',
    },
  });
it('keeps three explicit Slack channel pages accessible in server order without duplicate IDs', async () => {
  const discover = vi.fn(async (input: { connectionId?: string; cursor?: string }) =>
    sources(input.connectionId, input.cursor)
  );
  await mount(
    <EventAgentEditor
      agent={eventAgentFixture()}
      onCancel={vi.fn()}
      onSave={noSave}
      onValidate={noPreview}
      onSources={discover}
    />
  );
  expect(discover).not.toHaveBeenCalled();
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('A one'));
  await click('More Slack channels');
  await waitForReact(() => expect(container.textContent).toContain('A two'));
  await click('More Slack channels');
  await waitForReact(() => expect(container.textContent).toContain('A three'));
  const displayed = [...container.querySelectorAll('[aria-label="Project sources"] p')]
    .map((node) => node.textContent)
    .filter((text) => text?.startsWith('A '));
  expect(displayed).toEqual([
    'A one · A-one',
    'A shared · A-shared',
    'A two · A-two',
    'A three · A-three',
  ]);
  expect(discover.mock.calls.map(([input]) => input.cursor)).toEqual([
    undefined,
    'page-2',
    'page-3',
  ]);
});
it('retains Slack records with a disabled loading control and retry after continuation failure', async () => {
  const gate = deferred();
  let fail = true;
  const discover = vi.fn(async (input: { cursor?: string }) => {
    if (input.cursor) {
      await gate.promise;
      if (fail) {
        throw new Error('Channel page unavailable');
      }
    }
    return sources('A', input.cursor);
  });
  await mount(
    <EventAgentEditor
      agent={eventAgentFixture()}
      onCancel={vi.fn()}
      onSave={noSave}
      onValidate={noPreview}
      onSources={discover}
    />
  );
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('A one'));
  await click('More Slack channels');
  expect(button('More Slack channels').disabled).toBe(true);
  expect(container.textContent).toContain('A one');
  await act(() => gate.resolve());
  await waitForReact(() => expect(container.textContent).toContain('Channel page unavailable'));
  expect(container.textContent).toContain('A one');
  fail = false;
  await click('Retry more Slack channels');
  await waitForReact(() => expect(container.textContent).toContain('A two'));
  expect(container.textContent).toContain('A one');
});
it('drops a late old-connection Slack page and clears its accumulated records', async () => {
  const gate = deferred();
  const discover = vi.fn(async (input: { connectionId?: string; cursor?: string }) => {
    const result = sources(input.connectionId, input.cursor);
    if (input.cursor && input.connectionId === 'A') {
      await gate.promise;
    }
    return result;
  });
  await mount(
    <EventAgentEditor
      agent={eventAgentFixture()}
      onCancel={vi.fn()}
      onSave={noSave}
      onValidate={noPreview}
      onSources={discover}
    />
  );
  await edit('input[id$="-connection"]', 'A');
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('A one'));
  await click('More Slack channels');
  await edit('input[id$="-connection"]', 'B');
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('B one'));
  await act(() => gate.resolve());
  expect(container.textContent).not.toContain('A one');
  expect(container.textContent).not.toContain('A two');
  expect(container.textContent).toContain('B one');
});
function retained(id: string) {
  const original = eventAgentFixture().configuredTriggers[0]!;
  return managedTriggerSchema.parse({
    ...original,
    id,
    isConfigured: false,
    configuration: { ...original.configuration!, description: `Retained ${id}` },
    capability: {
      status: 'UNAVAILABLE',
      reasonCode: 'REMOVED_TRIGGER',
      explanation: 'Retained removed event.',
    },
  });
}
function initialAgent() {
  return {
    ...eventAgentFixture(),
    configuredTriggers: [],
    retainedTriggers: [retained('first')],
    retainedNextCursor: 'page-2',
  };
}
function retainedPage(
  snapshot: EventAgent,
  input: { projectId: string; agentId: string; retainedCursor?: string }
) {
  const rows =
    input.retainedCursor === 'page-2'
      ? [retained('first'), retained('second'), retained('shared')]
      : [retained('shared'), retained('third')];
  return {
    ...snapshot,
    id: input.agentId,
    projectId: input.projectId,
    retainedTriggers: rows,
    retainedNextCursor: input.retainedCursor === 'page-2' ? 'page-3' : null,
  };
}
function retainedHarness() {
  let current: EventAgent = initialAgent();
  let pageWait: Promise<void> | undefined;
  let pageError = false;
  const requests: Array<{ projectId: string; agentId: string; retainedCursor?: string }> = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const input = z
              .object({
                projectId: z.string(),
                agentId: z.string(),
                retainedCursor: z.string().optional(),
              })
              .parse(op.input);
            requests.push(input);
            const snapshot = current;
            void Promise.resolve()
              .then(async () => {
                if (input.retainedCursor === 'page-3') {
                  await pageWait;
                  if (pageError) {
                    throw new Error('Retained page unavailable');
                  }
                }
                return retainedPage(snapshot, input);
              })
              .then(
                (data) => {
                  observer.next({ result: { data } });
                  observer.complete();
                },
                (error) => observer.error(TRPCClientError.from(error))
              );
          }),
    ],
  });
  return {
    requests,
    wait: (pending: Promise<void>) => {
      pageWait = pending;
    },
    fail: (value: boolean) => {
      pageError = value;
    },
    render: async (agent = current) => {
      current = agent;
      await mount(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <EventAgentInspection agent={agent} />
            <RetainedContinuation agent={agent} />
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  };
}
it('keeps three retained inspection pages visible with loading state and stable-ID deduplication', async () => {
  const harness = retainedHarness();
  await harness.render();
  await click('Load more retained triggers');
  await waitForReact(() => expect(container.textContent).toContain('Retained second'));
  const gate = deferred();
  harness.wait(gate.promise);
  await click('Load more retained triggers');
  expect(container.textContent).toContain('Retained second');
  expect(button('Load more retained triggers').disabled).toBe(true);
  expect(container.textContent).toContain('Loading retained triggers');
  await act(() => gate.resolve());
  await waitForReact(() => expect(container.textContent).toContain('Retained third'));
  expect([...container.querySelectorAll('h4')].map((node) => node.textContent)).toEqual([
    'Retained first',
    'Retained second',
    'Retained shared',
    'Retained third',
  ]);
});
it('keeps earlier retained pages accessible after a failed continuation and retries the same cursor', async () => {
  const harness = retainedHarness();
  await harness.render();
  await click('Load more retained triggers');
  await waitForReact(() => expect(container.textContent).toContain('Retained second'));
  harness.fail(true);
  await click('Load more retained triggers');
  await waitForReact(() => expect(container.textContent).toContain('Retained page unavailable'));
  expect(container.textContent).toContain('Retained second');
  harness.fail(false);
  await click('Retry retained triggers');
  await waitForReact(() => expect(container.textContent).toContain('Retained third'));
  expect(container.textContent).toContain('Retained second');
});
it.each(['project', 'agent', 'revision'] as const)(
  'resets retained continuation on %s changes and ignores late old-scope pages',
  async (scope) => {
    const harness = retainedHarness();
    await harness.render();
    await click('Load more retained triggers');
    await waitForReact(() => expect(container.textContent).toContain('Retained second'));
    const gate = deferred();
    harness.wait(gate.promise);
    await click('Load more retained triggers');
    const changed = {
      ...initialAgent(),
      ...(scope === 'project'
        ? { projectId: 'other' }
        : scope === 'agent'
          ? { id: 'other-agent' }
          : { managementRevision: 3 }),
    };
    await harness.render(changed);
    expect(container.textContent).not.toContain('Retained second');
    expect(button('Load more retained triggers').disabled).toBe(false);
    await act(() => gate.resolve());
    expect(container.textContent).not.toContain('Retained third');
    expect(container.textContent).not.toContain('Retained second');
  }
);
it.each([
  ['preview', 'success'],
  ['save', 'success'],
  ['preview', 'failure'],
  ['save', 'failure'],
] as const)(
  'does not let old reload %s/%s replace a newer draft, feedback or busy state',
  async (operation, outcome) => {
    const reload = deferred();
    const source = deferred();
    const newer = deferred();
    const baseline = eventAgentFixture();
    const saving = vi.fn(() => newer.promise);
    await mount(
      <EventAgentEditor
        agent={baseline}
        onCancel={vi.fn()}
        onSave={saving}
        onValidate={async () => {
          await newer.promise;
          return noPreview();
        }}
        onSources={async () => {
          await source.promise;
          return sources();
        }}
        onReload={async () => {
          await reload.promise;
          if (outcome === 'failure') {
            throw new Error('Older reload failed');
          }
          return {
            ...baseline,
            name: 'Reload result should not replace the draft',
            managementRevision: 4,
          };
        }}
      />
    );
    await edit('input[name="name"]', 'Keep newer operation draft');
    await click('Discard edits and reload saved configuration');
    await click('Refresh project sources');
    if (operation === 'preview') {
      await click('Validate draft');
    } else {
      await act(() =>
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      );
    }
    await act(() => reload.resolve());
    expect(container.textContent).not.toContain('Older reload failed');
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Keep newer operation draft'
    );
    if (operation === 'preview') {
      expect(container.textContent).toContain('Validating current draft');
    } else {
      expect(
        container.querySelector<HTMLInputElement>('input[name="name"]')?.matches(':disabled')
      ).toBe(true);
      await act(() =>
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      );
      expect(saving).toHaveBeenCalledTimes(1);
    }
    await act(() => newer.resolve());
    await act(() => source.resolve());
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Keep newer operation draft'
    );
  }
);

it('clears accumulated Slack pages when deliberately reloading a newer saved baseline', async () => {
  const baseline = eventAgentFixture();
  const discover = vi.fn(async (input: { cursor?: string }) => sources('A', input.cursor));
  await mount(
    <EventAgentEditor
      agent={baseline}
      onCancel={vi.fn()}
      onSave={noSave}
      onValidate={noPreview}
      onSources={discover}
      onReload={() => Promise.resolve({ ...baseline, managementRevision: 3 })}
    />
  );
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('A one'));
  await click('More Slack channels');
  await waitForReact(() => expect(container.textContent).toContain('A two'));
  await click('Discard edits and reload saved configuration');
  await waitForReact(() => expect(container.textContent).toContain('Saved management revision 3'));
  expect(container.querySelector('[aria-label="Project sources"]')).toBeNull();
  await click('Refresh project sources');
  await waitForReact(() => expect(container.textContent).toContain('A one'));
  expect(container.textContent).not.toContain('A two');
  expect(discover.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
});
