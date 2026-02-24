import {
  CIStatus as PackageCIStatus,
  IssueProvider as PackageIssueProvider,
  KanbanColumn as PackageKanbanColumn,
  PRState as PackagePRState,
  RatchetState as PackageRatchetState,
  RunScriptStatus as PackageRunScriptStatus,
  SessionStatus as PackageSessionStatus,
  WorkspaceCreationSource as PackageWorkspaceCreationSource,
  WorkspaceStatus as PackageWorkspaceStatus,
} from '@factory-factory/core-types/enums';
import { describe, expect, it } from 'vitest';
import {
  CIStatus,
  IssueProvider,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
  WorkspaceCreationSource,
  WorkspaceStatus,
} from './enums';

type SharedEnums = {
  WorkspaceStatus: Record<string, string>;
  SessionStatus: Record<string, string>;
  PRState: Record<string, string>;
  CIStatus: Record<string, string>;
  KanbanColumn: Record<string, string>;
  RatchetState: Record<string, string>;
  WorkspaceCreationSource: Record<string, string>;
  IssueProvider: Record<string, string>;
  RunScriptStatus: Record<string, string>;
};

const appEnums: SharedEnums = {
  WorkspaceStatus,
  SessionStatus,
  PRState,
  CIStatus,
  KanbanColumn,
  RatchetState,
  WorkspaceCreationSource,
  IssueProvider,
  RunScriptStatus,
};

describe('core enum drift guard', () => {
  it('keeps app shared core enums synchronized with @factory-factory/core', () => {
    const packageEnums: SharedEnums = {
      WorkspaceStatus: PackageWorkspaceStatus,
      SessionStatus: PackageSessionStatus,
      PRState: PackagePRState,
      CIStatus: PackageCIStatus,
      KanbanColumn: PackageKanbanColumn,
      RatchetState: PackageRatchetState,
      WorkspaceCreationSource: PackageWorkspaceCreationSource,
      IssueProvider: PackageIssueProvider,
      RunScriptStatus: PackageRunScriptStatus,
    };

    expect(packageEnums).toEqual(appEnums);
  });
});
