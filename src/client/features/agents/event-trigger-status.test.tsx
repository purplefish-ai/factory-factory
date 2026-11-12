// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backendEnable,
  backendExpireActivation,
  backendVerifySlackChannel,
  eventAgentFixture,
  slackTriggerFixture,
  triggerInBackendState,
} from './event-agent.test-support';
import {
  describeAutomationState,
  describeSourceHealth,
  describeTriggerState,
  isTriggerRunning,
  EventTriggerCard,
} from './event-trigger-status';
import type { EventAgent } from './types';

type Trigger = EventAgent['configuredTriggers'][number];
const base = eventAgentFixture().configuredTriggers[0]!;
function trigger(overrides: Partial<Trigger>): Trigger {
  return { ...base, ...overrides };
}
// The backend's exact combinations: only ACTIVE carries isEnabled: true.
const listening = triggerInBackendState(base, 'ACTIVE');
const starting = triggerInBackendState(base, 'STARTING');
const unsupported = trigger({
  capability: {
    status: 'UNAVAILABLE',
    reasonCode: 'SLACK_INTAKE_UNAVAILABLE',
    explanation: 'Slack event intake is not running in this app.',
  },
});
const updatedAt = '2026-11-12T00:00:00.000Z';

describe('describeTriggerState', () => {
  it('shows a supported active trigger as Listening', () => {
    expect(describeTriggerState(listening)).toMatchObject({ label: 'Listening', reason: null });
  });

  it('shows a starting trigger as Starting', () => {
    expect(describeTriggerState(starting).label).toBe('Starting');
  });

  it('shows an active-looking trigger that is not enabled as Paused', () => {
    expect(
      describeTriggerState(trigger({ activationState: 'ACTIVE', isEnabled: false })).label
    ).toBe('Paused');
  });

  it.each([
    ['ACTIVATION_EXPIRED', /took too long to start/],
    ['SOURCE_ERROR', /couldn't be read/],
    ['SOURCE_RECOVERY_REQUIRED', /needs a reset/],
  ] as const)('explains a trigger paused with %s', (pausedReasonCode, reason) => {
    const state = describeTriggerState(trigger({ pausedReasonCode }));
    expect(state.label).toBe('Paused');
    expect(state.reason).toMatch(reason);
  });

  it('shows Paused without a reason when nothing went wrong', () => {
    expect(describeTriggerState(base)).toMatchObject({ label: 'Paused', reason: null });
  });

  it("shows an unsupported trigger as Can't run with the server's explanation", () => {
    expect(describeTriggerState(unsupported)).toMatchObject({
      label: "Can't run",
      reason: 'Slack event intake is not running in this app.',
    });
    // Capability wins over a stale runtime flag.
    expect(
      describeTriggerState({ ...unsupported, activationState: 'ACTIVE', isEnabled: true }).label
    ).toBe("Can't run");
  });
});

// Regression: the backend writes a starting trigger with isEnabled: false
// (startTrigger); only activate sets isEnabled: true, with ACTIVE.
describe('the backend field combination for each state', () => {
  it.each([
    ['PAUSED', null, 'Paused', false, 'Paused'],
    ['PAUSED', 'SOURCE_ERROR', 'Paused', false, 'Paused'],
    ['STARTING', null, 'Starting', true, 'Starting'],
    ['ACTIVE', null, 'Listening', true, 'Active'],
  ] as const)('%s (reason %s) reads %s', (state, pausedReasonCode, label, running, automation) => {
    const stored = triggerInBackendState(base, state, pausedReasonCode);
    expect(stored.isEnabled).toBe(state === 'ACTIVE');
    expect(describeTriggerState(stored).label).toBe(label);
    expect(isTriggerRunning(stored)).toBe(running);
    expect(describeAutomationState([stored])).toBe(automation);
  });
});

describe('describeAutomationState', () => {
  it('reads the automation from its triggers, not the definition flag', () => {
    expect(describeAutomationState([listening, base])).toBe('Active');
    expect(describeAutomationState([starting, base])).toBe('Starting');
    // An edit leaves the definition enabled while every trigger is paused.
    expect(describeAutomationState([base, unsupported])).toBe('Paused');
    expect(describeAutomationState([])).toBe('Paused');
  });
});

describe('describeSourceHealth', () => {
  it.each([
    [null, 'No source status yet'],
    [{ state: 'READY', reasonCode: null, updatedAt }, 'Up to date'],
    [{ state: 'CATCHING_UP', reasonCode: null, updatedAt }, 'Catching up on recent events'],
    [
      { state: 'DISCONNECTED', reasonCode: 'GITHUB_SOURCE_RESET', updatedAt },
      'Reset. Enable the automation to listen from now on.',
    ],
    [
      { state: 'ERROR', reasonCode: 'GITHUB_BASELINE_REQUIRED', updatedAt },
      'Waiting for a fresh starting point from GitHub',
    ],
    [
      { state: 'ERROR', reasonCode: 'GITHUB_AUTH_REQUIRED', updatedAt },
      'GitHub sign-in needed. Run gh auth login; checking resumes on its own.',
    ],
    [
      { state: 'RECOVERY_REQUIRED', reasonCode: 'GITHUB_CONTINUITY_LOST', updatedAt },
      'Needs a reset: GitHub can no longer list every event since the last check',
    ],
    [{ state: 'ERROR', reasonCode: 'SOMETHING_NEW', updatedAt }, "Couldn't read the source"],
  ] as const)('describes %o in words', (health, words) => {
    expect(describeSourceHealth(health)).toBe(words);
  });
});

describe('EventTriggerCard', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('states the trigger plainly and keeps raw JSON and revisions in collapsed details', async () => {
    await act(() =>
      root.render(
        <EventTriggerCard
          trigger={trigger({
            pausedReasonCode: 'SOURCE_ERROR',
            sourceHealth: { state: 'ERROR', reasonCode: 'GITHUB_RATE_LIMITED', updatedAt },
          })}
        />
      )
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    const visible = [...container.querySelector('article')!.children]
      .filter((child) => child.tagName !== 'DETAILS')
      .map((child) => child.textContent)
      .join(' ');
    expect(visible).toContain('Investigate labeled issues');
    expect(visible).toContain('Paused');
    expect(visible).toContain("couldn't be read");
    expect(visible).toContain('example/repo');
    expect(visible).toContain('GitHub rate limit reached');
    expect(visible).not.toContain('revision');
    expect(visible).not.toContain('"connectionId"');
    expect(visible).not.toContain('GITHUB_RATE_LIMITED');
    expect(details?.textContent).toContain('Trigger revision 1');
    expect(details?.textContent).toContain('"connectionId": "github-connection"');
    expect(details?.textContent).toContain('GITHUB_RATE_LIMITED');
  });
});

describe('a Slack trigger waiting for its test message', () => {
  const agent = { ...eventAgentFixture(), configuredTriggers: [slackTriggerFixture(['C1', 'C2'])] };
  const enabled = backendEnable(agent);
  const startingSlack = enabled.configuredTriggers[0]!;
  const ready = { state: 'READY' as const, reasonCode: null, updatedAt };
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('is stored as the backend writes it: STARTING, not enabled, every channel waiting', () => {
    expect(startingSlack).toMatchObject({
      activationState: 'STARTING',
      isEnabled: false,
      pendingVerification: {
        message: 'Factory Factory check r5tc-8mzk-q2ye',
        expiresAt: '2026-11-12T09:10:00.000Z',
        channels: [
          { channelId: 'C1', name: '#support', verified: false },
          { channelId: 'C2', name: '#customer-feedback', verified: false },
        ],
      },
    });
  });

  it('reads Connecting until the listener is ready, then waits for the test message', () => {
    expect(describeTriggerState(startingSlack)).toMatchObject({
      label: 'Starting',
      reason: 'Connecting…',
    });
    expect(describeTriggerState({ ...startingSlack, sourceHealth: ready })).toMatchObject({
      label: 'Starting',
      reason: 'Connected; waiting for test message',
    });
    expect(isTriggerRunning(startingSlack)).toBe(true);
  });

  it('shows the exact message with a copy button, each channel and the expiry', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    const partly = backendVerifySlackChannel(enabled, 'C1').configuredTriggers[0]!;
    await act(() => root.render(<EventTriggerCard trigger={{ ...partly, sourceHealth: ready }} />));
    const section = container.querySelector('section[aria-label="Slack test message"]');
    expect(section?.querySelector('code')?.textContent).toBe(
      'Factory Factory check r5tc-8mzk-q2ye'
    );
    const items = [...(section?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
    expect(items).toEqual(['#supportReceived', '#customer-feedbackWaiting']);
    expect(section?.textContent).toContain('1 of 2 received');
    expect(section?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-11-12T09:10:00.000Z'
    );
    const copy = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Copy message'
    );
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(copied).toEqual(['Factory Factory check r5tc-8mzk-q2ye']);
    expect(container.textContent).toContain('Copied');
  });

  it('starts listening once every channel is verified, with no message left to show', async () => {
    const active = backendVerifySlackChannel(backendVerifySlackChannel(enabled, 'C1'), 'C2')
      .configuredTriggers[0]!;
    expect(active).toMatchObject({
      activationState: 'ACTIVE',
      isEnabled: true,
      pendingVerification: null,
    });
    expect(describeTriggerState(active).label).toBe('Listening');
    await act(() => root.render(<EventTriggerCard trigger={active} />));
    expect(container.querySelector('section[aria-label="Slack test message"]')).toBeNull();
  });

  it('gets a new message when enabled again after expiry, as the backend issues a new code', () => {
    const again = backendEnable(backendExpireActivation(enabled)).configuredTriggers[0]!;
    expect(again.activationGeneration).toBe(3);
    expect(again.pendingVerification?.message).toMatch(/^Factory Factory check /);
    expect(again.pendingVerification?.message).not.toBe(startingSlack.pendingVerification?.message);
  });

  it('shows no message to post when the trigger can no longer run', async () => {
    await act(() =>
      root.render(
        <EventTriggerCard
          trigger={{
            ...startingSlack,
            capability: {
              status: 'UNAVAILABLE',
              reasonCode: 'SLACK_INTAKE_UNAVAILABLE',
              explanation: 'Slack event intake is not available yet.',
            },
          }}
        />
      )
    );
    expect(container.textContent).toContain("Can't run");
    expect(container.querySelector('section[aria-label="Slack test message"]')).toBeNull();
  });

  it('explains an expired test window and offers nothing to post', async () => {
    const paused = backendExpireActivation(enabled).configuredTriggers[0]!;
    expect(paused).toMatchObject({
      activationState: 'PAUSED',
      pausedReasonCode: 'ACTIVATION_EXPIRED',
      pendingVerification: null,
    });
    expect(describeTriggerState(paused)).toMatchObject({
      label: 'Paused',
      reason: expect.stringMatching(/didn't arrive in every channel within 10 minutes/),
    });
    expect(isTriggerRunning(paused)).toBe(false);
    await act(() => root.render(<EventTriggerCard trigger={paused} />));
    expect(container.querySelector('section[aria-label="Slack test message"]')).toBeNull();
  });
});
