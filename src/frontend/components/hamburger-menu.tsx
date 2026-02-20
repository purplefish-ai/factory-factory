import { GitPullRequest, Kanban, Menu, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { useAppNavigationData } from '@/frontend/hooks/use-app-navigation-data';
import { LogoIcon } from './logo';
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
      {/* Compact header row */}
      <div className="flex items-center gap-2 px-1 pb-1 pr-0.5">
        <LogoIcon className="h-7 w-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <ProjectSelectorDropdown
            selectedProjectSlug={navData.selectedProjectSlug}
            onProjectChange={(value) => {
              navData.handleProjectChange(value);
              onClose();
            }}
            projects={navData.projects}
          />
        </div>
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Close menu">
            <X className="h-4 w-4" />
          </Button>
        </SheetClose>
      </div>

      <Separator />

      {/* Active Workspaces */}
      <div>
        <p className="px-2 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
          Active Workspaces
        </p>
        {activeWorkspaces.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {activeWorkspaces.map((workspace) => (
              <SheetClose key={workspace.id} asChild>
                <Link
                  to={`/projects/${navData.selectedProjectSlug}/workspaces/${workspace.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                  data-active={workspace.id === navData.currentWorkspaceId || undefined}
                >
                  <WorkspaceStatusIcon
                    pendingRequestType={workspace.pendingRequestType}
                    isWorking={workspace.isWorking}
                  />
                  <span className="truncate">{workspace.name}</span>
                </Link>
              </SheetClose>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-[60px] text-muted-foreground text-sm">
            No active workspaces
          </div>
        )}
      </div>

      {/* Bottom section: Reviews, Admin */}
      <div className="mt-auto flex flex-col gap-1">
        <Separator />
        <div className="flex flex-col gap-0.5">
          <SheetClose asChild>
            <Link
              to={`/projects/${navData.selectedProjectSlug}/workspaces`}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                pathname?.startsWith(`/projects/${navData.selectedProjectSlug}/workspaces`)
                  ? 'bg-accent'
                  : 'hover:bg-accent'
              }`}
            >
              <Kanban className="h-4 w-4" />
              <span>Workspaces Board</span>
            </Link>
          </SheetClose>
          <SheetClose asChild>
            <Link
              to="/reviews"
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
          </SheetClose>
          <div className="flex items-center gap-1">
            <SheetClose asChild>
              <Link
                to="/admin"
                className={`flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  pathname === '/admin' || pathname?.startsWith('/admin/')
                    ? 'bg-accent'
                    : 'hover:bg-accent'
                }`}
              >
                <Settings className="h-4 w-4" />
                <span>Admin Dashboard</span>
              </Link>
            </SheetClose>
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
        className="w-full sm:w-[24rem] sm:max-w-[24rem] p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] overflow-y-auto [&>button:first-child]:hidden"
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
