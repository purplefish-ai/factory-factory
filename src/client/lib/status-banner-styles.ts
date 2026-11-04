import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { getStatusToneStyle, type StatusTone } from './status-tones';

const STATUS_BANNER_TONES: Record<WorkspaceInitBanner['kind'], StatusTone> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
};

export function getStatusBannerClassName(kind: WorkspaceInitBanner['kind']): string {
  return getStatusToneStyle(STATUS_BANNER_TONES[kind]).surface;
}
