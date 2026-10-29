import { useEffect, useRef } from 'react';
import { useAppNavigationDataContext } from '@/client/hooks/use-app-navigation-data';
import { trpc } from '@/client/lib/trpc';
import type { Agent } from './types';

/**
 * Resolve explicit deep links before trusting the last selected project.
 * Navigation belongs to explicit user actions; project state can normalize
 * automatically while the requested task is still loading.
 */
export function useAgentProject(
  id: string | undefined,
  task: Agent | undefined,
  onProjectSwitch: () => void
) {
  const navigation = useAppNavigationDataContext();
  const { projects, selectedProjectSlug, selectProjectSlug } = navigation;
  const ownerInList = projects?.find((project) => project.id === task?.projectId);
  const ownerQuery = trpc.project.getById.useQuery(
    { id: task?.projectId ?? '' },
    { enabled: !!task && !ownerInList }
  );
  const owner = ownerInList ?? ownerQuery.data;
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
  const project = id ? owner : selectedProject;
  const resolvedId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!id) {
      resolvedId.current = undefined;
      return;
    }
    if (!ownerInList || resolvedId.current === id) {
      return;
    }
    resolvedId.current = id;
    selectProjectSlug(ownerInList.slug);
  }, [id, ownerInList, selectProjectSlug]);

  return {
    project,
    projects:
      owner && !projects?.some((candidate) => candidate.id === owner.id)
        ? [...(projects ?? []), owner]
        : (projects ?? []),
    projectsLoading: !(projects || navigation.projectsError),
    projectsError: navigation.projectsError,
    retryProjects: navigation.refetchProjects,
    ownerLoading: !!task && !owner && !ownerQuery.error,
    ownerError: ownerQuery.error,
    retryOwner: ownerQuery.refetch,
    selectProject: (projectId: string) => {
      const next = projects?.find((candidate) => candidate.id === projectId);
      if (!next) {
        return;
      }
      selectProjectSlug(next.slug);
      onProjectSwitch();
    },
  };
}
