/**
 * Shared diff styling utilities for consistent visual output.
 *
 * Colors use the theme's status tokens (docs/status-colors.md): additions are
 * success, deletions destructive and hunk headers info, so diffs follow the
 * selected color scheme in light and dark mode.
 */

import type { DiffLineType, SimpleDiffLineType } from './types';

/**
 * Get background color class for a detailed diff line type
 */
export function getDiffLineBackground(type: DiffLineType): string {
  const bgColors: Record<DiffLineType, string> = {
    header: 'bg-muted/50',
    hunk: 'bg-info/10',
    addition: 'bg-success/15',
    deletion: 'bg-destructive/15',
    context: '',
  };
  return bgColors[type];
}

/**
 * Get text color class for a detailed diff line type
 */
export function getDiffLineTextColor(type: DiffLineType): string {
  const textColors: Record<DiffLineType, string> = {
    header: 'text-muted-foreground',
    hunk: 'text-info',
    addition: 'text-success',
    deletion: 'text-destructive',
    context: 'text-foreground',
  };
  return textColors[type];
}

/**
 * Get prefix character for a detailed diff line type
 */
export function getDiffLinePrefix(type: DiffLineType): string {
  const prefixes: Record<DiffLineType, string> = {
    header: '',
    hunk: '',
    addition: '+',
    deletion: '-',
    context: ' ',
  };
  return prefixes[type];
}

/**
 * Get background color class for a simple diff line type (PR detail panel)
 */
export function getSimpleDiffLineClassName(type: SimpleDiffLineType): string {
  switch (type) {
    case 'add':
      return 'bg-success/10 text-success';
    case 'del':
      return 'bg-destructive/10 text-destructive';
    default:
      return '';
  }
}

/**
 * Get prefix character for a simple diff line type (PR detail panel)
 */
export function getSimpleDiffLinePrefix(type: SimpleDiffLineType): string {
  switch (type) {
    case 'add':
      return '+';
    case 'del':
      return '-';
    default:
      return ' ';
  }
}
