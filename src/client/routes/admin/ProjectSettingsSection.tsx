import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { LinkIcon } from '@phosphor-icons/react/dist/csr/Link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCodeIcon className="w-5 h-5" />
            Factory configuration
          </CardTitle>
          <CardDescription>
            Configuration for workspace setup and run scripts (factory-factory.json)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProjectFactoryConfigCard
            key={selectedProject.id}
            projectId={selectedProject.id}
            projectName={selectedProject.name}
          />
          <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
            <p>
              <strong>Port Allocation:</strong> Use{' '}
              <code className="bg-muted px-1 rounded">{'{port}'}</code> in run script for automatic
              port allocation
            </p>
            <p>
              <strong>Location:</strong> factory-factory.json in repository root
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="w-5 h-5" />
            Issue tracking
          </CardTitle>
          <CardDescription>Configure the issue provider (GitHub Issues or Linear)</CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectIssueTrackingCard
            key={selectedProject.id}
            projectId={selectedProject.id}
            projectName={selectedProject.name}
            currentProvider={selectedProject.issueProvider}
            issueTrackerConfig={selectedProject.issueTrackerConfig}
          />
        </CardContent>
      </Card>
    </div>
  );
}
