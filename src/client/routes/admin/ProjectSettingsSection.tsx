import type { PublicIssueTrackerConfig } from '@/shared/schemas/issue-tracker-config.schema';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';
import { ProjectFactoryConfigCard } from './ProjectFactoryConfigCard';

export interface SettingsProject {
  id: string;
  slug: string;
  name: string;
  issueProvider: string;
  issueTrackerConfig: PublicIssueTrackerConfig | null;
}

export function ProjectSettingsSection({ project: selectedProject }: { project: SettingsProject }) {
  return (
    <div className="space-y-6">
      <ProjectFactoryConfigCard
        key={`factory-${selectedProject.id}`}
        projectId={selectedProject.id}
        projectName={selectedProject.name}
      />
      <ProjectIssueTrackingCard
        key={`issues-${selectedProject.id}`}
        projectId={selectedProject.id}
        projectName={selectedProject.name}
        currentProvider={selectedProject.issueProvider}
        issueTrackerConfig={selectedProject.issueTrackerConfig}
      />
    </div>
  );
}
