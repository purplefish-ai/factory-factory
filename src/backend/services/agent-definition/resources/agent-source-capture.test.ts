import { describe, expect, it } from 'vitest';
import type { AgentIssueEventPage } from '@/shared/agent-source';
import type { AgentSourceEntry } from '@/shared/agent-source-state';
import { capturePage, newScan, resumeScan, verifyPage } from './agent-source-scan';

function page(ids: string[], nextPage: number | null): AgentIssueEventPage {
  return { events: ids.map((providerEventId) => ({ providerEventId, payload: null })), nextPage };
}
function entries(ids: string[]): AgentSourceEntry[] {
  return ids.map((providerEventId) => ({ providerEventId, eventId: null }));
}
function partialOverlap() {
  let scan = newScan('H', 'boundary');
  const captured = entries(['H', 'A', 'B']);
  capturePage(scan, [], page(['H', 'A', 'B'], 2));
  scan = resumeScan(scan);
  capturePage(scan, captured, page(['new', 'H', 'A'], 2));
  expect(scan.overlapOffset).toBe(2);
  return { scan, captured };
}

describe('resumed capture', () => {
  it.each([false, true])(
    'reproves a shifted anchored overlap across pages (restart: %s)',
    (restart) => {
      const { captured, scan: initialScan } = partialOverlap();
      let scan = initialScan;
      if (restart) {
        scan = resumeScan(scan);
      }
      expect(capturePage(scan, captured, page(['A', 'B', 'C'], 3))).toEqual(
        page(['C'], null).events
      );
      expect(scan.overlapOffset).toBeNull();
      expect(scan.resumeIds).toEqual(['C']);
      expect(scan.nextPage).toBe(3);
    }
  );

  it.each([
    ['unknown', 'B', 'C'],
    ['B', 'A', 'C'],
    ['A', 'H', 'B'],
    ['A', 'C', 'B'],
  ])('rejects a broken overlap %j', (...ids) => {
    const { scan, captured } = partialOverlap();
    expect(() => capturePage(scan, captured, page(ids, 3))).toThrow('continuity');
  });

  it('advances after an overlap-only page even when each cycle has only one read', () => {
    let scan = newScan('H', 'boundary');
    const captured = entries(['H', 'A']);
    capturePage(scan, [], page(['H', 'A'], 2));
    scan = resumeScan(scan);
    expect(scan.nextPage).toBe(1);
    expect(capturePage(scan, captured, page(['H', 'A'], 2))).toEqual([]);
    scan = resumeScan(scan);
    expect(scan.nextPage).toBe(2);
    expect(capturePage(scan, captured, page(['B', 'boundary'], null))).toEqual(
      page(['B'], null).events
    );
    expect(scan.phase).toBe('VERIFY');
    verifyPage(scan, [...captured, ...entries(['B'])], page(['H', 'A', 'B', 'boundary'], null));
    expect(scan.phase).toBe('FINALIZE');
  });

  it('advances after a shifted overlap completes with no fresh identities', () => {
    const { captured, scan: initialScan } = partialOverlap();
    let scan = initialScan;
    capturePage(scan, captured, page(['A', 'B'], 3));
    scan = resumeScan(scan);
    expect(scan.nextPage).toBe(3);
    capturePage(scan, captured, page(['C', 'boundary'], null));
    expect(scan.phase).toBe('VERIFY');
  });

  it('still detects a removed captured identity after overlap-only progress', () => {
    let scan = newScan('H', 'boundary');
    const captured = entries(['H', 'A']);
    capturePage(scan, [], page(['H', 'A'], 2));
    scan = resumeScan(scan);
    capturePage(scan, captured, page(['H', 'A'], 2));
    scan = resumeScan(scan);
    capturePage(scan, captured, page(['B', 'boundary'], null));
    expect(() =>
      verifyPage(scan, [...captured, ...entries(['B'])], page(['H', 'B', 'boundary'], null))
    ).toThrow('continuity');
  });
});
