import { describe, expect, it } from 'vitest';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
  WorkspaceCreationSource,
  WorkspaceStatus,
} from './enums';

describe('domain enums', () => {
  it('WorkspaceStatus has all expected values', () => {
    expect(Object.values(WorkspaceStatus)).toEqual([
      'NEW',
      'PROVISIONING',
      'READY',
      'FAILED',
      'ARCHIVED',
    ]);
  });

  it('SessionStatus has all expected values', () => {
    expect(Object.values(SessionStatus)).toEqual([
      'IDLE',
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'FAILED',
    ]);
  });

  it('PRState has all expected values', () => {
    expect(Object.values(PRState)).toEqual([
      'NONE',
      'DRAFT',
      'OPEN',
      'CHANGES_REQUESTED',
      'APPROVED',
      'MERGED',
      'CLOSED',
    ]);
  });

  it('CIStatus has all expected values', () => {
    expect(Object.values(CIStatus)).toEqual(['UNKNOWN', 'PENDING', 'SUCCESS', 'FAILURE']);
  });

  it('KanbanColumn has all expected values', () => {
    expect(Object.values(KanbanColumn)).toEqual(['WORKING', 'WAITING', 'DONE']);
  });

  it('RatchetState has all expected values', () => {
    expect(Object.values(RatchetState)).toEqual([
      'IDLE',
      'CI_RUNNING',
      'CI_FAILED',
      'REVIEW_PENDING',
      'READY',
      'MERGED',
    ]);
  });

  it('WorkspaceCreationSource has all expected values', () => {
    expect(Object.values(WorkspaceCreationSource)).toEqual([
      'MANUAL',
      'RESUME_BRANCH',
      'GITHUB_ISSUE',
    ]);
  });

  it('RunScriptStatus has all expected values', () => {
    expect(Object.values(RunScriptStatus)).toEqual([
      'IDLE',
      'STARTING',
      'RUNNING',
      'STOPPING',
      'COMPLETED',
      'FAILED',
    ]);
  });

  it('enum values can be used as string literals', () => {
    const status: string = WorkspaceStatus.READY;
    expect(status).toBe('READY');

    const session: string = SessionStatus.RUNNING;
    expect(session).toBe('RUNNING');
  });
});
