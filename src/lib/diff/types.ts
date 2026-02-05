/**
 * Shared diff types used across the application
 */

/**
 * Type of diff line for detailed line-by-line parsing
 */
export type DiffLineType = 'header' | 'addition' | 'deletion' | 'context' | 'hunk';

/**
 * Simple diff line type used in file-based parsing
 */
export type SimpleDiffLineType = 'add' | 'del' | 'context';

/**
 * Line number information for a diff line
 */
export interface LineNumber {
  old?: number;
  new?: number;
}

/**
 * Detailed diff line with line numbers (used in workspace diff viewer)
 */
export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNumber?: LineNumber;
}

/**
 * Simple diff line (used in PR detail panel)
 */
export interface SimpleDiffLine {
  type: SimpleDiffLineType;
  content: string;
}

/**
 * Diff hunk containing a group of related lines
 */
export interface DiffHunk {
  header: string;
  lines: SimpleDiffLine[];
}

/**
 * Parsed diff file containing hunks and stats
 */
export interface DiffFile {
  name: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}
