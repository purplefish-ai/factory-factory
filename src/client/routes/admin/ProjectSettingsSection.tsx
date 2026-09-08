import { FileCodeIcon, LinkIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { readSelectedProjectSlug, writeSelectedProjectSlug } from '@/client/lib/project-selection';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PublicIssueTrackerConfig } from '@/shared/schemas/issue-tracker-config.schema';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';
import { ProjectFactoryConfigCard } from './ProjectFactoryConfigCard';

export function ProjectSettingsSection({
  projects,
}: {
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    issueProvider: string;
    issueTrackerConfig: PublicIssueTrackerConfig | null;
  }>;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string>(
    () => readSelectedProjectSlug() || projects[0]?.slug || ''
  );

  const selectedProject = projects.find((p) => p.slug === selectedSlug) ?? projects[0];

  const handleProjectChange = (slug: string) => {
    setSelectedSlug(slug);
    writeSelectedProjectSlug(slug);
  };

  if (!selectedProject) {
    return <p className="text-sm text-muted-foreground">No projects found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Select value={selectedProject.slug} onValueChange={handleProjectChange}>
          <SelectTrigger className="w-auto max-w-xs">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.slug}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCodeIcon className="w-5 h-5" />
            Factory Configuration
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
            Issue Tracking
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
