import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@/components/ui/button';
import { createRecoveryImportReport } from '@/shared/recovery-import-report';
import { recoveryMetadataSchema } from '@/shared/schemas/recovery-envelope.schema';
import fullJson from '@/shared/testing/recovery-base-json-v8.fixture.json';
import workspaceJson from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import periodic from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import links from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import { DataImportResultsProvider, useDataImportResults } from './data-import-results';

type ImportResult = Parameters<ReturnType<typeof useDataImportResults>['publishImportResult']>[0];
const created: ImportResult = {
  recovery: createRecoveryImportReport(undefined),
  projects: { imported: 2, skipped: 0 },
  workspaces: { imported: 4, skipped: 0 },
  agentSessions: { imported: 6, skipped: 0 },
  terminalSessions: { imported: 3, skipped: 0 },
  userSettings: { imported: true, skipped: false },
  inertTransforms: {
    workspaceWorkflows: 0,
    workspaceInitializations: 0,
    workspaceArchives: 0,
    runScripts: 0,
    terminalSessions: 0,
    agentSessions: 0,
    monitors: 0,
    heldReceipts: 0,
    cancelledFacts: 0,
    explanations: [],
  },
};
const mixed: ImportResult = {
  recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(fixed.meta.recovery)),
  projects: { imported: 1, skipped: 2 },
  workspaces: { imported: 4, skipped: 3 },
  agentSessions: { imported: 5, skipped: 6 },
  terminalSessions: { imported: 2, skipped: 1 },
  userSettings: { imported: false, skipped: true },
  inertTransforms: {
    workspaceWorkflows: 3,
    workspaceInitializations: 1,
    workspaceArchives: 2,
    runScripts: 3,
    terminalSessions: 2,
    agentSessions: 5,
    monitors: 4,
    heldReceipts: 3,
    cancelledFacts: 2,
    explanations: [
      'Imported running agent sessions were stopped; provider history identities were retained.',
      'Unfinished receipt groups remain held. Review imported workspaces before enabling monitoring.',
    ],
  },
};
function Publish({ result }: { result: ImportResult }) {
  const { publishImportResult } = useDataImportResults();
  return <Button onClick={() => publishImportResult(result)}>Show import results</Button>;
}
function ResultsStory({ result }: { result: ImportResult }) {
  return (
    <DataImportResultsProvider onDismiss={() => document.getElementById('story-content')?.focus()}>
      <main id="story-content" tabIndex={-1} className="p-6">
        <h1 className="mb-4 text-xl">Backup imports</h1>
        <Publish result={result} />
      </main>
    </DataImportResultsProvider>
  );
}
const meta = {
  title: 'Data import/Results',
  component: ResultsStory,
  parameters: { layout: 'fullscreen' },
  args: { result: created },
} satisfies Meta<typeof ResultsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllCreated: Story = {};
export const MixedSkippedAndStopped: Story = { args: { result: mixed } };
export const LongResults: Story = {
  args: {
    result: {
      ...mixed,
      inertTransforms: {
        ...mixed.inertTransforms,
        explanations: Array.from(
          { length: 40 },
          (_, index) =>
            `Workspace ${index + 1}: initialization needs manual attention. Review the original status and recovery guidance before retrying.`
        ),
      },
    },
  },
};

export const PartialCoverage: Story = { args: { result: mixed } };
export const LegacyNoDeclaration: Story = { args: { result: created } };

export const WorkspaceJsonFidelity: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(
        recoveryMetadataSchema.parse(workspaceJson.meta.recovery)
      ),
    },
  },
};

export const BaseJsonFidelity: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(fullJson.meta.recovery)),
    },
  },
};

export const PeriodicConfigRecovery: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(periodic.meta.recovery), {
        model: 'PeriodicTask',
        imported: 2,
        skipped: 3,
        sourceEnabled: 4,
        restoredDisabled: 2,
        reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
      }),
    },
  },
};

export const PeriodicWorkspaceLinksRecovery: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(
        recoveryMetadataSchema.parse(links.meta.recovery),
        {
          model: 'PeriodicTask',
          imported: 2,
          skipped: 3,
          sourceEnabled: 4,
          restoredDisabled: 2,
          reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
        },
        { model: 'Workspace', imported: 2, skipped: 3, reasons: { INCOMPLETE_DEPENDENCY: 3 } }
      ),
    },
  },
};

export const PeriodicHistoryRecovery: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(
        recoveryMetadataSchema.parse(history.meta.recovery),
        {
          model: 'PeriodicTask',
          imported: 2,
          skipped: 3,
          sourceEnabled: 4,
          restoredDisabled: 2,
          reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
        },
        { model: 'Workspace', imported: 2, skipped: 3, reasons: { INCOMPLETE_DEPENDENCY: 3 } },
        {
          model: 'PeriodicTaskExecution',
          imported: 3,
          skipped: 6,
          sourceRunning: 5,
          restoredHistoricalFailed: 2,
          restoredSettled: 1,
          reasons: {
            EXISTING_IDENTITY: 1,
            CONFLICTING_IDENTITY_OR_PARENT: 2,
            INCOMPLETE_DEPENDENCY: 3,
          },
        }
      ),
    },
  },
};
export const PeriodicHistoryAllSkipped: Story = {
  args: {
    result: {
      ...mixed,
      recovery: createRecoveryImportReport(
        recoveryMetadataSchema.parse(history.meta.recovery),
        undefined,
        undefined,
        {
          model: 'PeriodicTaskExecution',
          imported: 0,
          skipped: 3,
          sourceRunning: 2,
          restoredHistoricalFailed: 0,
          restoredSettled: 0,
          reasons: {
            EXISTING_IDENTITY: 1,
            CONFLICTING_IDENTITY_OR_PARENT: 1,
            INCOMPLETE_DEPENDENCY: 1,
          },
        }
      ),
    },
  },
};
