import type { ReactNode } from 'react';
import { HeaderLeftStartSlot, useAppHeader } from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { useProjectHeaderNavigation } from '@/client/hooks/use-project-header-navigation';
import { SettingsTabsList } from './settings-tabs-list';

function GlobalSettingsHeader() {
  useAppHeader({ title: '' });
  const {
    selectedProjectSlug,
    projects,
    projectsError,
    refetchProjects,
    handleProjectChange,
    handleCurrentProjectSelect,
  } = useProjectHeaderNavigation();
  return (
    <HeaderLeftStartSlot>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
        <ProjectSelectorDropdown
          selectedProjectSlug={selectedProjectSlug}
          onProjectChange={handleProjectChange}
          onCurrentProjectSelect={selectedProjectSlug ? handleCurrentProjectSelect : undefined}
          projects={projects}
          showLeadingSlash
          showTrailingSlash
          triggerId="settings-header-project-select"
          onRetryProjects={
            projectsError
              ? () => {
                  void refetchProjects();
                }
              : undefined
          }
        />
        <span aria-current="page" className="truncate text-sm font-semibold">
          Settings
        </span>
        {projectsError ? (
          <span role="alert" className="sr-only">
            Couldn't load projects. {projectsError.message}
          </span>
        ) : null}
      </nav>
    </HeaderLeftStartSlot>
  );
}

export function SettingsPageLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <GlobalSettingsHeader />
      <div className="space-y-6 p-3 md:p-6">
        <SettingsTabsList />
        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}
