// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStoryTrpcClient } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import {
  agentRecoveryContextSchema,
  agentRecoveryInputSchema,
  agentRecoveryTargetInputSchema,
} from '@/shared/event-agent-recovery';
import { settle, waitForCheck } from '@/test-utils/react-act';
import { EventAgentHistory } from './event-agent-history';
import { eventAgentFixture } from './event-agent.test-support';
import { eventRunFixture } from './event-history.story-fixtures';
import {
  type RecoveryFixture,
  recoveryInspectionFixture,
  recoveryResultFixture,
  recoveryRunFixture,
  recoveryTargetFixture,
  staleRecoveryContextError,
  unavailableTargetFixture,
  unprovenAbandonedRunFixture,
} from './event-run-recovery.story-fixtures';
import type { EventRun } from './types';

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let requests: Array<{ path: string; input: unknown }>;
let runs: EventRun[];
let respond: Record<string, (input: unknown) => unknown>;

const count = (path: string) => requests.filter((request) => request.path === path).length;

/** Serves recovery for one fixture state, as the backend does. */
function serveRecovery(recovery: RecoveryFixture, options: { retryUnavailable?: boolean } = {}) {
  const target = recoveryTargetFixture(recovery);
  // A request for any other run, or with an altered context, fails the read.
  respond['automation.recoveryTarget'] = (input) => {
    expect(agentRecoveryTargetInputSchema.parse(input)).toEqual({
      projectId: 'owner',
      agentId: 'event-agent',
      runId: recoveryRunFixture(recovery).id,
    });
    return target;
  };
  respond['automation.inspectRun'] = (input) => {
    expect(target.status === 'AVAILABLE').toBe(true);
    expect(agentRecoveryContextSchema.parse(input)).toEqual({
      agentId: 'event-agent',
      ...(target.status === 'AVAILABLE' ? target.context : {}),
    });
    return recoveryInspectionFixture(recovery, options);
  };
  respond['automation.resolveAmbiguousRun'] = (input) => recoveryResultFixture(input);
}

function render(archived = false) {
  const client = createStoryTrpcClient({
    onRequest: (path, input) => requests.push({ path, input }),
    handlers: {
      'automation.runs': () => ({ items: runs, nextCursor: null }),
      'automation.evaluations': () => ({ items: [], nextCursor: null }),
      'automation.recoveryTarget': (input) => respond['automation.recoveryTarget']?.(input),
      'automation.inspectRun': (input) => respond['automation.inspectRun']?.(input),
      'automation.resolveAmbiguousRun': (input) =>
        respond['automation.resolveAmbiguousRun']?.(input),
      'automation.navigationSummary': () => ({ totalCount: 1, failedCount: 0 }),
    },
  });
  act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventAgentHistory
              agent={eventAgentFixture()}
              projectSlug="owner"
              archived={archived}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}

function runArticle(runId: string) {
  const article = container.querySelector(`[data-run-id="${runId}"]`);
  if (!(article instanceof HTMLElement)) {
    throw new Error(`Missing run ${runId}`);
  }
  return article;
}

function buttonIn(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
}

function requireButton(scope: ParentNode | null, text: string) {
  const found = scope ? buttonIn(scope, text) : undefined;
  if (!found) {
    throw new Error(`Missing button ${text}`);
  }
  return found;
}

const inspection = () => document.body.querySelector('[role="dialog"]');
const confirmation = () => document.body.querySelector('[role="alertdialog"]');

async function openInspection(runId: string) {
  await waitForCheck(() => expect(buttonIn(runArticle(runId), 'Inspect')).toBeDefined());
  await act(async () => requireButton(runArticle(runId), 'Inspect').click());
  await waitForCheck(() => expect(inspection()?.textContent).toContain('First message'));
  return inspection() as HTMLElement;
}

async function choose(action: 'Resolve' | 'Abandon' | 'Retry') {
  await act(async () => requireButton(inspection(), action).click());
  await waitForCheck(() => expect(confirmation()).not.toBeNull());
  return confirmation() as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  respond = {};
  runs = [
    recoveryRunFixture('resolved'),
    recoveryRunFixture('deliveryUncertain'),
    recoveryRunFixture('heldAfterTurn'),
    recoveryRunFixture('childHeld'),
    eventRunFixture(),
    eventRunFixture({
      id: 'run-queued',
      startedAt: null,
      completedAt: null,
      status: 'QUEUED',
      launchPhase: 'RESERVED',
      initialOutcome: null,
      result: null,
      reservedWorkspaceId: null,
      reservedSessionId: null,
      workspaceId: null,
      workspaceState: 'UNRESERVED',
    }),
  ];
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('EventRunRecovery', () => {
  it('offers Inspect only on running runs that need a decision, and reads a resolved run as needing attention', async () => {
    render();
    await waitForCheck(() => expect(container.querySelector('[data-run-id]')).not.toBeNull());

    for (const runId of ['run-resolved', 'run-deliveryUncertain', 'run-heldAfterTurn']) {
      expect(buttonIn(runArticle(runId), 'Inspect')).toBeDefined();
    }
    expect(buttonIn(runArticle('run-pr'), 'Inspect')).toBeUndefined();
    expect(buttonIn(runArticle('run-queued'), 'Inspect')).toBeUndefined();

    const resolved = runArticle('run-resolved');
    expect(resolved.textContent).toContain('Needs attention');
    expect(resolved.textContent).not.toContain('Running');
    // Nothing is read until a person asks for it.
    expect(count('automation.recoveryTarget')).toBe(0);
  });

  it('shows only the actions the server reports available, with the reason for the others', async () => {
    serveRecovery('heldAfterTurn', { retryUnavailable: true });
    render();
    const dialog = await openInspection('run-heldAfterTurn');

    expect(buttonIn(dialog, 'Resolve')).toBeDefined();
    expect(buttonIn(dialog, 'Abandon')).toBeDefined();
    expect(buttonIn(dialog, 'Retry')).toBeUndefined();
    expect(dialog.textContent).toContain("Retry isn't available");
    expect(dialog.textContent).toContain(
      "The run's workspace, session or account is no longer available"
    );
    // The inspection went to the server with the target's exact context.
    const target = recoveryTargetFixture('heldAfterTurn');
    if (target.status !== 'AVAILABLE') {
      throw new Error('Expected an available target');
    }
    expect(requests.find((request) => request.path === 'automation.inspectRun')?.input).toEqual({
      agentId: 'event-agent',
      ...target.context,
    });
  });

  it('names the block when no action is available', async () => {
    serveRecovery('deliveryUncertain');
    respond['automation.inspectRun'] = () => ({
      ...recoveryInspectionFixture('deliveryUncertain'),
      unprovenAbandonAvailable: false,
    });
    render();
    const dialog = await openInspection('run-deliveryUncertain');

    for (const action of ['Resolve', 'Abandon', 'Retry', 'Abandon anyway']) {
      expect(buttonIn(dialog, action)).toBeUndefined();
    }
    expect(dialog.textContent).toContain('No recovery action is available');
    expect(dialog.textContent).toContain("can't confirm that this run's agent has stopped");
    expect(dialog.textContent).toContain('may have reached the agent');
  });

  it('offers Abandon anyway for a blocked run and sends the opt-in with the exact context', async () => {
    serveRecovery('deliveryUncertain');
    render();
    const dialog = await openInspection('run-deliveryUncertain');

    for (const action of ['Resolve', 'Abandon', 'Retry']) {
      expect(buttonIn(dialog, action)).toBeUndefined();
    }
    expect(dialog.textContent).toContain("Resolve, Retry and Abandon aren't available");
    await act(async () => requireButton(inspection(), 'Abandon anyway').click());
    await waitForCheck(() => expect(confirmation()).not.toBeNull());
    const confirm = confirmation() as HTMLElement;
    expect(confirm.textContent).toContain(
      "Factory Factory can't confirm this run's agent has stopped"
    );
    expect(confirm.textContent).toContain('frees its run slot');
    expect(confirm.textContent).toContain('keeps working in its workspace until you stop it there');
    expect(confirm.textContent).toContain('Check the workspace');
    expect(confirm.textContent).toContain(
      'recorded as Cancelled, because its first turn has no completed or failed result'
    );
    expect(confirm.textContent).not.toMatch(/archiv|delet|idle/i);

    await act(async () => requireButton(confirm, 'Abandon anyway').click());
    await waitForCheck(() =>
      expect(runArticle('run-deliveryUncertain').textContent).toContain('Run abandoned')
    );
    expect(runArticle('run-deliveryUncertain').textContent).toContain(
      "couldn't confirm its agent stopped"
    );
    const target = recoveryTargetFixture('deliveryUncertain');
    if (target.status !== 'AVAILABLE') {
      throw new Error('Expected an available target');
    }
    const sent = requests.filter((request) => request.path === 'automation.resolveAmbiguousRun');
    expect(sent).toHaveLength(1);
    expect(agentRecoveryInputSchema.parse(sent[0]?.input)).toEqual({
      agentId: 'event-agent',
      ...target.context,
      action: 'ABANDON',
      acceptUnprovenStop: true,
    });
  });

  it('says a run whose first turn completed keeps that result when abandoned anyway', async () => {
    runs = [recoveryRunFixture('trackingLost')];
    serveRecovery('trackingLost');
    render();
    await openInspection('run-trackingLost');
    await act(async () => requireButton(inspection(), 'Abandon anyway').click());
    await waitForCheck(() => expect(confirmation()).not.toBeNull());
    expect(confirmation()?.textContent).toContain(
      "This run will keep the result of its own first turn: it's recorded as Completed."
    );
    expect(confirmation()?.textContent).not.toContain('recorded as Cancelled');
  });

  it('does not promise Cancelled when the first turn finished after the list loaded', async () => {
    // The list row still shows the ambiguous send; the fresh inspection says it finished.
    serveRecovery('deliveryUncertain');
    respond['automation.inspectRun'] = () => recoveryInspectionFixture('trackingLost');
    respond['automation.recoveryTarget'] = () => recoveryTargetFixture('trackingLost');
    runs = [{ ...recoveryRunFixture('deliveryUncertain'), id: 'run-trackingLost' }];
    render();
    await openInspection('run-trackingLost');
    await act(async () => requireButton(inspection(), 'Abandon anyway').click());
    await waitForCheck(() => expect(confirmation()).not.toBeNull());
    expect(confirmation()?.textContent).toContain(
      'This run will keep the result of its own first turn.'
    );
    expect(confirmation()?.textContent).not.toContain('recorded as Cancelled');
  });

  it('reports an ordinary abandonment when the server proved the stop after all', async () => {
    serveRecovery('deliveryUncertain');
    // With the opt-in, the server still takes the proven path when proof turns up.
    respond['automation.resolveAmbiguousRun'] = () => ({ status: 'ABANDONED' });
    render();
    await openInspection('run-deliveryUncertain');
    await act(async () => requireButton(inspection(), 'Abandon anyway').click());
    await waitForCheck(() => expect(confirmation()).not.toBeNull());
    await act(async () => requireButton(confirmation(), 'Abandon anyway').click());

    const article = runArticle('run-deliveryUncertain');
    await waitForCheck(() => expect(article.textContent).toContain('Run abandoned'));
    expect(article.textContent).toContain('Child workspaces were not stopped');
    expect(article.textContent).not.toContain("couldn't confirm its agent stopped");
  });

  it('never sends the opt-in with an ordinary Abandon', async () => {
    serveRecovery('heldAfterTurn');
    render();
    await openInspection('run-heldAfterTurn');
    const confirm = await choose('Abandon');
    await act(async () => requireButton(confirm, 'Abandon run').click());
    await waitForCheck(() => expect(count('automation.resolveAmbiguousRun')).toBe(1));
    const sent = requests.find((request) => request.path === 'automation.resolveAmbiguousRun');
    expect(sent?.input).not.toHaveProperty('acceptUnprovenStop');
  });

  it('explains a run abandoned without a confirmed stop', async () => {
    runs = [unprovenAbandonedRunFixture()];
    render();
    await waitForCheck(() => expect(container.querySelector('[data-run-id]')).not.toBeNull());
    const ended = runArticle('run-deliveryUncertain');
    expect(ended.textContent).toContain('Cancelled');
    expect(ended.textContent).toContain("couldn't confirm its agent had stopped");
    expect(ended.textContent).not.toContain('Unrecognized reason');
    expect(buttonIn(ended, 'Inspect')).toBeUndefined();
  });

  it('offers only Abandon for a child-held run and says it keeps its outcome', async () => {
    serveRecovery('childHeld');
    render();
    const dialog = await openInspection('run-childHeld');

    expect(dialog.textContent).toContain('2 child workspaces');
    expect(dialog.textContent).toContain('Working');
    expect(dialog.textContent).toContain('Not started');
    expect(dialog.textContent).toMatch(/ends on its own/);
    expect(buttonIn(dialog, 'Resolve')).toBeUndefined();
    expect(buttonIn(dialog, 'Retry')).toBeUndefined();
    expect(dialog.textContent).toContain("Resolve isn't available");

    const confirm = await choose('Abandon');
    expect(confirm.textContent).toContain('This run will keep its outcome');
    expect(confirm.textContent).toContain('Completed');
    expect(confirm.textContent).toContain("doesn't stop this run's child workspaces");
    expect(confirm.textContent).not.toMatch(/archiv|delet|idle/i);
  });

  it('warns before Retry that earlier effects may already have happened', async () => {
    serveRecovery('heldAfterTurn');
    render();
    await openInspection('run-heldAfterTurn');
    const confirm = await choose('Retry');

    expect(confirm.textContent).toContain('Earlier effects may already have happened');
    expect(confirm.textContent).toContain('may already have reached the agent');
    expect(confirm.textContent).toContain('same workspace');
  });

  it('says what Abandon does to the run and that it leaves child workspaces running', async () => {
    serveRecovery('heldAfterTurn');
    render();
    await openInspection('run-heldAfterTurn');
    const confirm = await choose('Abandon');

    expect(confirm.textContent).toContain(
      'recorded as Cancelled, or Failed if its first turn failed'
    );
    expect(confirm.textContent).toContain('frees its run slot');
    expect(confirm.textContent).toContain("doesn't stop this run's child workspaces");
  });

  it('says Resolve keeps the run and its slot for a later decision', async () => {
    serveRecovery('heldAfterTurn');
    render();
    await openInspection('run-heldAfterTurn');
    const confirm = await choose('Resolve');

    expect(confirm.textContent).toContain('keeps its run slot');
    expect(confirm.textContent).toContain('retry or abandon it');
    expect(confirm.textContent).not.toMatch(/archiv|delet|idle/i);
  });

  it('keeps the dialog open on a stale context, offers a reload and sends nothing further', async () => {
    serveRecovery('heldAfterTurn');
    // Another tab retried the run after this one loaded its target.
    respond['automation.resolveAmbiguousRun'] = () => {
      throw staleRecoveryContextError();
    };
    render();
    await openInspection('run-heldAfterTurn');
    const confirm = await choose('Abandon');
    await act(async () => requireButton(confirm, 'Abandon run').click());

    await waitForCheck(() => expect(confirmation()?.textContent).toContain('This run changed'));
    const target = recoveryTargetFixture('heldAfterTurn');
    if (target.status !== 'AVAILABLE') {
      throw new Error('Expected an available target');
    }
    const sent = requests.filter((request) => request.path === 'automation.resolveAmbiguousRun');
    expect(sent).toHaveLength(1);
    expect(agentRecoveryInputSchema.parse(sent[0]?.input)).toEqual({
      agentId: 'event-agent',
      ...target.context,
      action: 'ABANDON',
    });

    await settle(6);
    expect(confirmation()).not.toBeNull();
    expect(count('automation.resolveAmbiguousRun')).toBe(1);
    expect(count('automation.recoveryTarget')).toBe(1);
    expect(count('automation.inspectRun')).toBe(1);
    expect(buttonIn(confirmation() as HTMLElement, 'Abandon run')).toBeUndefined();

    // The rotated attempt is only read again when the person asks for it.
    respond['automation.recoveryTarget'] = () => recoveryTargetFixture('heldAfterTurn', 2);
    respond['automation.inspectRun'] = () =>
      recoveryInspectionFixture('heldAfterTurn', { attemptGeneration: 2 });
    await act(async () => requireButton(confirmation(), 'Reload').click());
    await waitForCheck(() => expect(count('automation.recoveryTarget')).toBe(2));
    await waitForCheck(() =>
      expect(buttonIn(inspection() as HTMLElement, 'Abandon')).toBeDefined()
    );
    expect(confirmation()).toBeNull();
    expect(count('automation.resolveAmbiguousRun')).toBe(1);
  });

  it('reports a blocked action in the dialog without claiming the run changed', async () => {
    serveRecovery('childHeld');
    respond['automation.resolveAmbiguousRun'] = (input) =>
      recoveryResultFixture(input, 'CHILD_WORK_UNPROVEN');
    render();
    await openInspection('run-childHeld');
    const confirm = await choose('Abandon');
    await act(async () => requireButton(confirm, 'Abandon run').click());

    await waitForCheck(() =>
      expect(confirmation()?.textContent).toContain("Abandon wasn't applied")
    );
    expect(confirmation()?.textContent).toContain('child workspaces');
    expect(confirmation()?.textContent).toContain("The run's status didn't change");
    expect(requireButton(confirmation(), 'Reload')).toBeDefined();
    expect(count('automation.resolveAmbiguousRun')).toBe(1);
  });

  it('refreshes the run list and the navigation summary after a successful action', async () => {
    serveRecovery('heldAfterTurn');
    render();
    const summaryKey = getQueryKey(
      trpc.automation.navigationSummary,
      { projectId: 'owner' },
      'query'
    );
    queryClient.setQueryData(summaryKey, { totalCount: 1, failedCount: 0 });
    await openInspection('run-heldAfterTurn');
    const runReads = count('automation.runs');
    const confirm = await choose('Abandon');
    await act(async () => requireButton(confirm, 'Abandon run').click());

    await waitForCheck(() =>
      expect(runArticle('run-heldAfterTurn').textContent).toContain('Run abandoned')
    );
    expect(confirmation()).toBeNull();
    expect(inspection()).toBeNull();
    await waitForCheck(() => expect(count('automation.runs')).toBeGreaterThan(runReads));
    expect(queryClient.getQueryState(summaryKey)?.isInvalidated).toBe(true);
    expect(count('automation.resolveAmbiguousRun')).toBe(1);
  });

  it('reads the run again each time Inspect opens', async () => {
    serveRecovery('heldAfterTurn');
    render();
    await openInspection('run-heldAfterTurn');
    await act(async () => requireButton(inspection(), 'Close').click());
    await waitForCheck(() => expect(inspection()).toBeNull());

    await openInspection('run-heldAfterTurn');
    expect(count('automation.recoveryTarget')).toBe(2);
    expect(count('automation.inspectRun')).toBe(2);
  });

  it('says when a run has already finished', async () => {
    respond['automation.recoveryTarget'] = () => unavailableTargetFixture('run-resolved');
    render();
    await waitForCheck(() => expect(buttonIn(runArticle('run-resolved'), 'Inspect')).toBeDefined());
    await act(async () => requireButton(runArticle('run-resolved'), 'Inspect').click());

    await waitForCheck(() => expect(inspection()?.textContent).toContain('already finished'));
    expect(count('automation.inspectRun')).toBe(0);
  });

  it('disables recovery in an archived project', async () => {
    render(true);
    await waitForCheck(() => expect(buttonIn(runArticle('run-resolved'), 'Inspect')).toBeDefined());
    expect(requireButton(runArticle('run-resolved'), 'Inspect').disabled).toBe(true);
  });

  it('builds every fixture from the shared recovery schemas', () => {
    for (const recovery of [
      'heldAfterTurn',
      'resolved',
      'childHeld',
      'deliveryUncertain',
      'setupUncertain',
      'trackingLost',
    ] as const) {
      const target = recoveryTargetFixture(recovery);
      const inspected = recoveryInspectionFixture(recovery);
      expect(target.status === 'AVAILABLE' && target.context).toEqual(inspected.context);
      expect(inspected.run.deliveryState).toBe(recoveryRunFixture(recovery).delivery?.state);
    }
  });
});
