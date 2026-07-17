import {
  CIStatus as PackageCIStatus,
  IssueProvider as PackageIssueProvider,
  KanbanColumn as PackageKanbanColumn,
  PRState as PackagePRState,
  RatchetReviewTriggerMode as PackageRatchetReviewTriggerMode,
  RatchetState as PackageRatchetState,
  RunScriptStatus as PackageRunScriptStatus,
  SessionPermissionPreset as PackageSessionPermissionPreset,
  SessionProvider as PackageSessionProvider,
  SessionStatus as PackageSessionStatus,
  WorkspaceCreationSource as PackageWorkspaceCreationSource,
  WorkspaceProviderSelection as PackageWorkspaceProviderSelection,
  WorkspaceStatus as PackageWorkspaceStatus,
} from '@factory-factory/core-types/enums';
import { describe, expect, it } from 'vitest';
import {
  CIStatus,
  IssueProvider,
  KanbanColumn,
  PRState,
  RatchetReviewTriggerMode,
  RatchetState,
  RunScriptStatus,
  SessionPermissionPreset,
  SessionProvider,
  SessionStatus,
  WorkspaceCreationSource,
  WorkspaceProviderSelection,
  WorkspaceStatus,
} from './enums';

type SharedEnums = {
  WorkspaceStatus: Record<string, string>;
  SessionStatus: Record<string, string>;
  SessionProvider: Record<string, string>;
  SessionPermissionPreset: Record<string, string>;
  WorkspaceProviderSelection: Record<string, string>;
  PRState: Record<string, string>;
  CIStatus: Record<string, string>;
  KanbanColumn: Record<string, string>;
  RatchetState: Record<string, string>;
  RatchetReviewTriggerMode: Record<string, string>;
  WorkspaceCreationSource: Record<string, string>;
  IssueProvider: Record<string, string>;
  RunScriptStatus: Record<string, string>;
};

const appEnums: SharedEnums = {
  WorkspaceStatus,
  SessionStatus,
  SessionProvider,
  SessionPermissionPreset,
  WorkspaceProviderSelection,
  PRState,
  CIStatus,
  KanbanColumn,
  RatchetState,
  RatchetReviewTriggerMode,
  WorkspaceCreationSource,
  IssueProvider,
  RunScriptStatus,
};

describe('core enum drift guard', () => {
  it('keeps app shared core enums synchronized with @factory-factory/core', () => {
    const packageEnums: SharedEnums = {
      WorkspaceStatus: PackageWorkspaceStatus,
      SessionStatus: PackageSessionStatus,
      SessionProvider: PackageSessionProvider,
      SessionPermissionPreset: PackageSessionPermissionPreset,
      WorkspaceProviderSelection: PackageWorkspaceProviderSelection,
      PRState: PackagePRState,
      CIStatus: PackageCIStatus,
      KanbanColumn: PackageKanbanColumn,
      RatchetState: PackageRatchetState,
      RatchetReviewTriggerMode: PackageRatchetReviewTriggerMode,
      WorkspaceCreationSource: PackageWorkspaceCreationSource,
      IssueProvider: PackageIssueProvider,
      RunScriptStatus: PackageRunScriptStatus,
    };

    expect(RatchetReviewTriggerMode).toBeDefined();
    expect(PackageRatchetReviewTriggerMode).toBeDefined();
    expect(packageEnums).toEqual(appEnums);
  });
});
