import type { WorkspaceInitBanner } from '@/shared/workspace-init';

const STATUS_BANNER_CLASS_NAMES: Record<WorkspaceInitBanner['kind'], string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  info: 'border-info/30 bg-info/10 text-info',
};

export function getStatusBannerClassName(kind: WorkspaceInitBanner['kind']): string {
  return STATUS_BANNER_CLASS_NAMES[kind];
}
