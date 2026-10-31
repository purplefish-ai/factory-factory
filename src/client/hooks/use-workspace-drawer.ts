import { useIsMobile } from '@/hooks/use-mobile';

// A side-by-side workspace needs more room than general mobile navigation.
export const WORKSPACE_DRAWER_BREAKPOINT = 1024;
export function useWorkspaceDrawer() {
  return useIsMobile(WORKSPACE_DRAWER_BREAKPOINT);
}
