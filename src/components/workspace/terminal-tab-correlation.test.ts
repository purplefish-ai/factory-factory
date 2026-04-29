import { describe, expect, it } from 'vitest';
import { claimPendingTerminalTab, removePendingTerminalTab } from './terminal-tab-correlation';

describe('terminal tab create correlation', () => {
  it('claims the tab matching the created response request id', () => {
    const pendingTabs = new Map([
      ['request-1', 'tab-1'],
      ['request-2', 'tab-2'],
    ]);

    expect(claimPendingTerminalTab(pendingTabs, 'request-2')).toBe('tab-2');
    expect(claimPendingTerminalTab(pendingTabs, 'request-1')).toBe('tab-1');
    expect(pendingTabs.size).toBe(0);
  });

  it('does not consume another pending tab for an unknown request id', () => {
    const pendingTabs = new Map([
      ['request-1', 'tab-1'],
      ['request-2', 'tab-2'],
    ]);

    expect(claimPendingTerminalTab(pendingTabs, 'request-3')).toBeNull();
    expect([...pendingTabs.entries()]).toEqual([
      ['request-1', 'tab-1'],
      ['request-2', 'tab-2'],
    ]);
  });

  it('falls back to the oldest pending tab for legacy uncorrelated responses', () => {
    const pendingTabs = new Map([
      ['request-1', 'tab-1'],
      ['request-2', 'tab-2'],
    ]);

    expect(claimPendingTerminalTab(pendingTabs)).toBe('tab-1');
    expect([...pendingTabs.entries()]).toEqual([['request-2', 'tab-2']]);
  });

  it('removes a tab that is closed before its create response returns', () => {
    const pendingTabs = new Map([
      ['request-1', 'tab-1'],
      ['request-2', 'tab-2'],
    ]);

    removePendingTerminalTab(pendingTabs, 'tab-1');

    expect([...pendingTabs.entries()]).toEqual([['request-2', 'tab-2']]);
  });
});
