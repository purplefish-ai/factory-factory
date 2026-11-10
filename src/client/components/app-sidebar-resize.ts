import { z } from 'zod';

export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width';

export const SIDEBAR_DEFAULT_WIDTH = 352;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 640;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseSidebarWidth(value: string | null): number {
  if (value == null) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  const parsed = Number.parseFloat(value);
  return clampSidebarWidth(parsed);
}

/** The stored width in pixels, clamped to the supported range. */
export const StoredSidebarWidthSchema = z.string().transform(parseSidebarWidth);
