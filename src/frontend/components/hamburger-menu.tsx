import { GitPullRequest, Kanban, Menu, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { useAppNavigationData } from '@/frontend/hooks/use-app-navigation-data';
import { LogoText } from './logo';
import { ProjectSelectorDropdown } from './project-selector';
import { ThemeToggle } from './theme-toggle';
import { WorkspaceStatusIcon } from './workspace-status-icon';

type NavigationData = ReturnType<typeof useAppNavigationData>;

interface HamburgerMenuProps {
  navData: NavigationData;
}

function MenuContent({ navData, onClose }: HamburgerMenuProps & { onClose: () => void }) {
  const { pathname } = useLocation();

  // Filter to working/waiting workspaces
  const activeWorkspaces = (navData.serverWorkspaces ?? []).filter(
    (w) =>
      w.cachedKanbanColumn === 'WORKING' ||
      w.cachedKanbanColumn === 'WAITING' ||
      w.isWorking ||
      w.pendingRequestType
  );

  return (
    <div className="flex flex-col h-full gap-1">
      {/* Logo + Project Selector */}
      <div className="px-2 py-1">
        <LogoText className="text-xl" />
        <div className="mt-1">
          <ProjectSelectorDropdown
            selectedProjectSlug={navData.selectedProjectSlug}
            onProjectChange={(value) => {
              navData.handleProjectChange(value);
              onClose();
            }}
            projects={navData.projects}
          />
        </div>
      </div>

      <Separator />

      {/* Active Workspaces */}
      {activeWorkspaces.length > 0 && (
        <div>
          <p className="px-2 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
            Active Workspaces
          </p>
          <div className="flex flex-col gap-0.5">
            {activeWorkspaces.map((workspace) => (
              <Link
                key={workspace.id}
                to={`/projects/${navData.selectedProjectSlug}/workspaces/${workspace.id}`}
                onClick={onClose}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                data-active={workspace.id === navData.currentWorkspaceId || undefined}
              >
                <WorkspaceStatusIcon
                  pendingRequestType={workspace.pendingRequestType}
                  isWorking={workspace.isWorking}
                />
                <span className="truncate">{workspace.name}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Bottom section: Reviews, Admin */}
      <div className="mt-auto flex flex-col gap-1">
        <Separator />
        <div className="flex flex-col gap-0.5">
          <Link
            to={`/projects/${navData.selectedProjectSlug}/workspaces`}
            onClick={onClose}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
              pathname?.startsWith(`/projects/${navData.selectedProjectSlug}/workspaces`)
                ? 'bg-accent'
                : 'hover:bg-accent'
            }`}
          >
            <Kanban className="h-4 w-4" />
            <span>Workspaces Board</span>
          </Link>
          <Link
            to="/reviews"
            onClick={onClose}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
              pathname === '/reviews' || pathname?.startsWith('/reviews/')
                ? 'bg-accent'
                : 'hover:bg-accent'
            }`}
          >
            <GitPullRequest className="h-4 w-4" />
            <span>Reviews</span>
            {navData.reviewCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-auto h-5 min-w-5 px-1.5 text-xs bg-orange-500/20 text-orange-600 border-orange-500/30"
              >
                {navData.reviewCount}
              </Badge>
            )}
          </Link>
          <div className="flex items-center gap-1">
            <Link
              to="/admin"
              onClick={onClose}
              className={`flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                pathname === '/admin' || pathname?.startsWith('/admin/')
                  ? 'bg-accent'
                  : 'hover:bg-accent'
              }`}
            >
              <Settings className="h-4 w-4" />
              <span>Admin</span>
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
}

export function HamburgerMenu({ navData }: HamburgerMenuProps) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const prevPathnameRef = useRef(pathname);

  // Close on navigation
  useEffect(() => {
    if (pathname !== prevPathnameRef.current) {
      setOpen(false);
    }
    prevPathnameRef.current = pathname;
  }, [pathname]);

  const handleClose = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Menu"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <SheetContent
        side="left"
        className="w-full sm:w-96 sm:max-w-96 p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] overflow-y-auto [&>button:first-child]:top-[calc(env(safe-area-inset-top)+1.15rem)]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation Menu</SheetTitle>
          <SheetDescription>Navigate between workspaces, reviews, and settings.</SheetDescription>
        </SheetHeader>
        <MenuContent navData={navData} onClose={handleClose} />
      </SheetContent>
    </Sheet>
  );
}
