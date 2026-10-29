import { describe, expect, it } from 'vitest';
import { appRouter } from './index';

describe('application API surface', () => {
  it('removes all auto-iteration endpoints while retaining workspace, session and periodic APIs', () => {
    const procedures = Object.keys(appRouter._def.procedures);

    expect(procedures.some((path) => path.startsWith('autoIteration.'))).toBe(false);
    expect(procedures).toEqual(
      expect.arrayContaining(['workspace.create', 'session.createSession', 'periodicTask.list'])
    );
  });
});
