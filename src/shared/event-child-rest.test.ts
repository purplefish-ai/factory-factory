import { describe, expect, it } from 'vitest';
import {
  childHeldOutcome,
  eventChildRest,
  eventChildRestProof,
  eventChildRestSchema,
} from './event-child-rest';

describe('event child rest', () => {
  it('derives atRest from the children and rejects inconsistent or duplicate observations', () => {
    expect(eventChildRest([]).atRest).toBe(true);
    expect(
      eventChildRest([
        { workspaceId: 'a', state: 'IDLE' },
        { workspaceId: 'b', state: 'WAITING_ON_PERSON' },
        { workspaceId: 'c', state: 'SETUP_FAILED' },
        { workspaceId: 'd', state: 'ARCHIVED' },
      ]).atRest
    ).toBe(true);
    expect(eventChildRest([{ workspaceId: 'a', state: 'NOT_STARTED' }]).atRest).toBe(false);
    expect(
      eventChildRestSchema.safeParse({
        atRest: true,
        children: [{ workspaceId: 'a', state: 'WORKING' }],
      }).success
    ).toBe(false);
    expect(
      eventChildRestSchema.safeParse({
        atRest: true,
        children: [
          { workspaceId: 'a', state: 'IDLE' },
          { workspaceId: 'a', state: 'IDLE' },
        ],
      }).success
    ).toBe(false);
  });

  it('records bounded counts and at most 20 held children', () => {
    const rest = eventChildRest([
      { workspaceId: 'idle', state: 'IDLE' },
      ...Array.from({ length: 25 }, (_, index) => ({
        workspaceId: `working-${index}`,
        state: 'WORKING' as const,
      })),
    ]);
    const proof = eventChildRestProof(rest, new Date(0));
    expect(proof).toMatchObject({
      version: 1,
      observedAt: new Date(0).toISOString(),
      counts: { IDLE: 1, WORKING: 25, ARCHIVED: 0, NOT_STARTED: 0 },
    });
    expect(proof.held).toHaveLength(20);
    expect(proof.held[0]).toBe('working-0');
  });

  it('keeps completed and failed outcomes only', () => {
    expect(childHeldOutcome('COMPLETED', 0)).toBe('COMPLETED');
    expect(childHeldOutcome('COMPLETED', 2)).toBe('PR_CREATED');
    expect(childHeldOutcome('FAILED', 2)).toBe('FAILED');
    expect(childHeldOutcome('CANCELLED', 0)).toBeNull();
    expect(childHeldOutcome(undefined, 0)).toBeNull();
  });
});
