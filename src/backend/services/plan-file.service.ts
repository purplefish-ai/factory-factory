/**
 * Plan File Service
 *
 * Manages plan document files for planning mode sessions.
 * Handles creation, reading, and path management of plan files.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createLogger } from './logger.service';

const logger = createLogger('plan-file');

const PLANNING_DIR = 'planning';

/**
 * Generate a plan filename from the current date and branch name.
 * Format: YYYY-MM-DD-HHMM-<branch-name>.md
 */
function generatePlanFilename(branchName?: string | null): string {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const timePart = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');

  const branchPart = branchName
    ? branchName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-')
    : 'plan';

  return `${datePart}-${timePart}-${branchPart}.md`;
}

/**
 * Parse the plan title from the first `# heading` in the markdown content.
 */
export function parsePlanTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

/**
 * Plan file content result returned by getPlanContent.
 */
export interface PlanFileContent {
  content: string;
  lastModified: string;
  title: string | null;
  filePath: string;
}

class PlanFileService {
  /**
   * Create the initial plan file for a planning session.
   * Returns the relative path (from workspace root) to the created file.
   */
  async createPlanFile(worktreePath: string, branchName?: string | null): Promise<string> {
    const planDir = join(worktreePath, PLANNING_DIR);

    // Ensure planning directory exists
    if (!existsSync(planDir)) {
      mkdirSync(planDir, { recursive: true });
    }

    const filename = generatePlanFilename(branchName);
    const relativePath = join(PLANNING_DIR, filename);
    const fullPath = join(worktreePath, relativePath);

    const initialContent = `# Plan

## Overview

_Describe the goal of this plan._

## Current State

_What exists today._

## Proposed Changes

_Outline the phases of work._

## Open Questions

_Items needing further discussion._

## Risks and Mitigations

_Potential issues and how to address them._
`;

    await writeFile(fullPath, initialContent, 'utf-8');
    logger.info('Created plan file', { relativePath, worktreePath });
    return relativePath;
  }

  /**
   * Read plan file content from disk.
   * Validates the path is within the workspace.
   */
  getPlanContent(worktreePath: string, relativePath: string): PlanFileContent | null {
    const fullPath = resolve(worktreePath, relativePath);
    const resolvedWorktree = resolve(worktreePath);

    // Security: ensure path is within workspace
    if (!fullPath.startsWith(resolvedWorktree + sep) && fullPath !== resolvedWorktree) {
      logger.warn('Plan file path escapes workspace', { fullPath, worktreePath });
      return null;
    }

    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const stat = statSync(fullPath);
      const title = parsePlanTitle(content);

      return {
        content,
        lastModified: stat.mtime.toISOString(),
        title,
        filePath: relativePath,
      };
    } catch (error) {
      logger.error('Failed to read plan file', {
        fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * List existing plan files in a workspace's planning/ directory.
   * Returns relative paths sorted by modification time (newest first).
   */
  listPlanFiles(worktreePath: string): string[] {
    const planDir = join(worktreePath, PLANNING_DIR);
    if (!existsSync(planDir)) {
      return [];
    }

    try {
      const files: string[] = readdirSync(planDir)
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => join(PLANNING_DIR, f));

      // Sort by modification time, newest first
      files.sort((a: string, b: string) => {
        const aStat = statSync(join(worktreePath, a));
        const bStat = statSync(join(worktreePath, b));
        return bStat.mtime.getTime() - aStat.mtime.getTime();
      });

      return files;
    } catch (error) {
      logger.error('Failed to list plan files', {
        planDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

export const planFileService = new PlanFileService();
