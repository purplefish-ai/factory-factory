import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  KeyboardShortcutsDialog,
  useDesktopCommands,
  useShortcut,
} from '@/client/features/shortcuts';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import {
  getProjectNewWorkspacePath,
  getProjectSectionPath,
  type ProjectSection,
} from '@/client/lib/project-navigation';
import { useSidebar } from '@/components/ui/sidebar';
import {
  getAdjacentWorkspaceId,
  getNextWorkspaceNeedingInput,
  getSidebarWorkspaceOrder,
} from './workspace-shortcut-navigation';

/** Settings entry point; update here when settings sections get their own URLs. */
export const SETTINGS_PATH = '/admin';
const PROJECTS_PATH = '/projects';

type ShortcutNavigationData = Pick<
  AppNavigationData,
  'selectedProjectSlug' | 'selectedProjectId' | 'serverWorkspaces' | 'currentWorkspaceId'
> & { needsAttention: (workspaceId: string) => boolean };

function useWorkspaceShortcuts(navData: ShortcutNavigationData) {
  const navigate = useNavigate();
  const slug = navData.selectedProjectId ? navData.selectedProjectSlug : '';
  const ordered = useMemo(
    () => getSidebarWorkspaceOrder(navData.serverWorkspaces ?? []),
    [navData.serverWorkspaces]
  );
  const openWorkspace = (workspaceId: string | null) => {
    if (!workspaceId) {
      return false;
    }
    void navigate(
      `${getProjectSectionPath(slug, 'workspaces')}/${encodeURIComponent(workspaceId)}`
    );
    return true;
  };
  const step = (direction: 1 | -1) =>
    openWorkspace(
      getAdjacentWorkspaceId(
        ordered.map((workspace) => workspace.id),
        navData.currentWorkspaceId,
        direction
      )
    );
  const hasWorkspaces = Boolean(slug) && ordered.length > 0;

  useShortcut('workspace.next', () => step(1), hasWorkspaces);
  useShortcut('workspace.previous', () => step(-1), hasWorkspaces);
  useShortcut(
    'workspace.nextNeedsInput',
    () => {
      const next = getNextWorkspaceNeedingInput(
        ordered,
        navData.currentWorkspaceId,
        navData.needsAttention
      );
      if (!next) {
        toast('No other workspace needs input');
        return;
      }
      openWorkspace(next);
    },
    hasWorkspaces
  );

  const goToSection = (section: ProjectSection) => {
    void navigate(getProjectSectionPath(slug, section));
  };
  useShortcut('nav.board', () => goToSection('workspaces'), Boolean(slug));
  useShortcut('nav.agents', () => goToSection('agents'), Boolean(slug));
  useShortcut('nav.reviews', () => goToSection('reviews'), Boolean(slug));
  useShortcut(
    'nav.newWorkspace',
    () => {
      void navigate(getProjectNewWorkspacePath(slug));
    },
    Boolean(slug)
  );
  useShortcut('nav.settings', () => {
    void navigate(SETTINGS_PATH);
  });
  useShortcut('nav.projects', () => {
    void navigate(PROJECTS_PATH);
  });
}

/**
 * App-wide shortcut handlers (sidebar, navigation, workspace switching) and the
 * "?" help dialog. Rendered once inside the app layout.
 */
export function AppShortcuts({ navData }: { navData: ShortcutNavigationData }) {
  const { toggleSidebar } = useSidebar();
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcut('app.toggleSidebar', () => {
    toggleSidebar();
  });
  useShortcut('app.showShortcuts', () => {
    setHelpOpen(true);
  });
  useWorkspaceShortcuts(navData);
  useDesktopCommands();

  return <KeyboardShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />;
}
