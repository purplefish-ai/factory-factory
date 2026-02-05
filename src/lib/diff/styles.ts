/**
 * Shared diff styling utilities for consistent visual output
 */

import type { DiffLineType, SimpleDiffLineType } from './types';

/**
 * Get background color class for a detailed diff line type
 */
export function getDiffLineBackground(type: DiffLineType): string {
  const bgColors: Record<DiffLineType, string> = {
    header: 'bg-muted/50',
    hunk: 'bg-blue-500/10',
    addition: 'bg-green-500/20',
    deletion: 'bg-red-500/20',
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
    hunk: 'text-blue-400',
    addition: 'text-green-400',
    deletion: 'text-red-400',
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
      return 'bg-green-500/15 text-green-700 dark:text-green-400';
    case 'del':
      return 'bg-red-500/15 text-red-700 dark:text-red-400';
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
