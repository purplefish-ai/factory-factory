import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { GitClientFactory } from '../clients/git.client';
import { gitCommand } from '../lib/shell';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { createLogger } from '../services/logger.service';
import { sessionService } from '../services/session.service';
import { terminalService } from '../services/terminal.service';
import { publicProcedure, router } from './trpc';

const logger = createLogger('workspace-trpc');

// =============================================================================
// Helper Types
// =============================================================================

export type GitFileStatus = 'M' | 'A' | 'D' | '?';

export interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse git status --porcelain output into structured data
 */
function parseGitStatusOutput(output: string): GitStatusFile[] {
  const lines = output.trim().split('\n').filter(Boolean);
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }

    // Format: XY filename
    // X = staged status, Y = unstaged status
    const stagedStatus = line[0];
    const unstagedStatus = line[1];
    const filePath = line.slice(3);

    // Determine if file is staged (has a non-space/non-? in first column)
    const staged = stagedStatus !== ' ' && stagedStatus !== '?';

    // Determine the status to show
    let status: GitFileStatus;
    if (stagedStatus === '?' || unstagedStatus === '?') {
      status = '?';
    } else if (stagedStatus === 'A' || unstagedStatus === 'A') {
      status = 'A';
    } else if (stagedStatus === 'D' || unstagedStatus === 'D') {
      status = 'D';
    } else {
      status = 'M';
    }

    files.push({ path: filePath, status, staged });
  }

  return files;
}

/**
 * Validate that a file path doesn't escape the worktree directory.
 * Uses path normalization and realpath to handle encoded sequences,
 * symlinks, and other bypass attempts.
 */
async function isPathSafe(worktreePath: string, filePath: string): Promise<boolean> {
  // Normalize the file path first to handle encoded sequences and resolve ./ etc
  const normalizedPath = path.normalize(filePath);

  // Check for path traversal attempts after normalization
  if (
    normalizedPath.startsWith('..') ||
    normalizedPath.includes(`${path.sep}..${path.sep}`) ||
    normalizedPath.includes(`${path.sep}..`) ||
    normalizedPath.startsWith(path.sep)
  ) {
    return false;
  }

  // Resolve the full path and ensure it's within the worktree
  const fullPath = path.resolve(worktreePath, normalizedPath);
  const normalizedWorktree = path.resolve(worktreePath);

  // Initial check before file exists
  if (!fullPath.startsWith(normalizedWorktree + path.sep) && fullPath !== normalizedWorktree) {
    return false;
  }

  // If the file exists, resolve symlinks and verify the real path is still within worktree
  try {
    const realFullPath = await realpath(fullPath);
    const realWorktree = await realpath(normalizedWorktree);
    return realFullPath.startsWith(realWorktree + path.sep) || realFullPath === realWorktree;
  } catch {
    // File doesn't exist yet (e.g., for new file creation) - rely on the initial check
    return true;
  }
}

/**
 * Get language from file extension for syntax highlighting
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    prisma: 'prisma',
  };
  return langMap[ext ?? ''] ?? 'text';
}

/**
 * Check if content is binary by looking for null bytes
 */
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// =============================================================================
// Router
// =============================================================================

export const workspaceRouter = router({
  // List workspaces for a project
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ input }) => {
      const { projectId, ...filters } = input;
      return workspaceAccessor.findByProjectId(projectId, filters);
    }),

  // Get workspace by ID
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const workspace = await workspaceAccessor.findById(input.id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.id}`);
    }
    return workspace;
  }),

  // Create a new workspace
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        branchName: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Create the workspace record
      const workspace = await workspaceAccessor.create(input);

      // Create the worktree for this workspace
      try {
        const workspaceWithProject = await workspaceAccessor.findByIdWithProject(workspace.id);
        if (!workspaceWithProject?.project) {
          throw new Error('Workspace project not found');
        }

        const project = workspaceWithProject.project;
        const gitClient = GitClientFactory.forProject({
          repoPath: project.repoPath,
          worktreeBasePath: project.worktreeBasePath,
        });

        const worktreeName = `workspace-${workspace.id}`;
        const baseBranch = input.branchName ?? project.defaultBranch;

        // Validate that the base branch exists before attempting to create worktree
        const branchExists = await gitClient.branchExists(baseBranch);
        if (!branchExists) {
          // Also check if it's a remote branch (origin/branchName)
          const remoteBranchExists = await gitClient.branchExists(`origin/${baseBranch}`);
          if (!remoteBranchExists) {
            throw new Error(
              `Branch '${baseBranch}' does not exist. Please specify an existing branch or leave empty to use the default branch '${project.defaultBranch}'.`
            );
          }
        }

        const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch);
        const worktreePath = gitClient.getWorktreePath(worktreeName);

        // Update workspace with worktree info
        return workspaceAccessor.update(workspace.id, {
          worktreePath,
          branchName: worktreeInfo.branchName,
        });
      } catch (error) {
        logger.error('Failed to create worktree for workspace', error as Error, {
          workspaceId: workspace.id,
        });
        // Throw error so user can see what went wrong
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create worktree: ${(error as Error).message}`,
          cause: error,
        });
      }
    }),

  // Update a workspace
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        worktreePath: z.string().optional(),
        branchName: z.string().optional(),
        prUrl: z.string().optional(),
        githubIssueNumber: z.number().optional(),
        githubIssueUrl: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return workspaceAccessor.update(id, updates);
    }),

  // Archive a workspace
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Clean up running sessions and terminals before archiving
    try {
      await sessionService.stopWorkspaceSessions(input.id);
      terminalService.destroyWorkspaceTerminals(input.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before archive', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspaceAccessor.archive(input.id);
  }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Clean up running sessions and terminals before deleting
    try {
      await sessionService.stopWorkspaceSessions(input.id);
      terminalService.destroyWorkspaceTerminals(input.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before delete', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspaceAccessor.delete(input.id);
  }),

  // =============================================================================
  // Git Operations
  // =============================================================================

  // Get git status for workspace
  getGitStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        return { files: [] };
      }

      const result = await gitCommand(['status', '--porcelain'], workspace.worktreePath);
      if (result.code !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
      }

      return { files: parseGitStatusOutput(result.stdout) };
    }),

  // Get file diff for workspace
  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace has no worktree path');
      }

      // Validate path is safe
      if (!(await isPathSafe(workspace.worktreePath, input.filePath))) {
        throw new Error('Invalid file path');
      }

      // Try to get diff with HEAD first (for staged/unstaged changes)
      let result = await gitCommand(['diff', 'HEAD', '--', input.filePath], workspace.worktreePath);

      // If empty, try without HEAD (for untracked files or other scenarios)
      if (result.stdout.trim() === '' && result.code === 0) {
        result = await gitCommand(['diff', '--', input.filePath], workspace.worktreePath);
      }

      // If still empty, try to show the file for new untracked files
      if (result.stdout.trim() === '' && result.code === 0) {
        // For untracked files, show the entire file as an addition
        const fullPath = path.join(workspace.worktreePath, input.filePath);
        try {
          const content = await readFile(fullPath, 'utf-8');
          // Format as a unified diff for a new file
          const lines = content.split('\n');
          const diffContent = [
            `diff --git a/${input.filePath} b/${input.filePath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${input.filePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
          ].join('\n');
          return { diff: diffContent };
        } catch {
          // File doesn't exist or can't be read
          return { diff: '' };
        }
      }

      if (result.code !== 0) {
        throw new Error(`Git diff failed: ${result.stderr}`);
      }

      return { diff: result.stdout };
    }),

  // =============================================================================
  // File Operations
  // =============================================================================

  // List files in directory
  listFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      logger.info('listFiles called', {
        workspaceId: input.workspaceId,
        worktreePath: workspace.worktreePath,
        requestedPath: input.path,
      });

      if (!workspace.worktreePath) {
        logger.warn('No worktreePath for workspace', { workspaceId: input.workspaceId });
        return { entries: [], hasWorktree: false };
      }

      const relativePath = input.path ?? '';

      // Validate path is safe
      if (relativePath && !(await isPathSafe(workspace.worktreePath, relativePath))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(workspace.worktreePath, relativePath);

      try {
        const dirents = await readdir(fullPath, { withFileTypes: true });

        const entries: FileEntry[] = [];
        for (const dirent of dirents) {
          // Skip .git directory
          if (dirent.name === '.git') {
            continue;
          }

          // Skip hidden files starting with . (optional, could make configurable)
          // if (dirent.name.startsWith('.')) continue;

          const entryPath = relativePath ? path.join(relativePath, dirent.name) : dirent.name;
          entries.push({
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : 'file',
            path: entryPath,
          });
        }

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        logger.info('listFiles returning entries', {
          workspaceId: input.workspaceId,
          fullPath,
          entryCount: entries.length,
        });

        return { entries, hasWorktree: true };
      } catch (error) {
        logger.error('listFiles error', error as Error, {
          workspaceId: input.workspaceId,
          fullPath,
          errorCode: (error as NodeJS.ErrnoException).code,
        });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { entries: [], hasWorktree: true };
        }
        throw error;
      }
    }),

  // Read file content
  readFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace has no worktree path');
      }

      // Validate path is safe
      if (!(await isPathSafe(workspace.worktreePath, input.path))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(workspace.worktreePath, input.path);

      // Get file stats to check size
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        throw new Error('Path is a directory');
      }

      const fileSize = stats.size;
      const truncated = fileSize > MAX_FILE_SIZE;

      // Read file content
      const buffer = await readFile(fullPath);

      // Check if binary
      if (isBinaryContent(buffer)) {
        return {
          content: '[Binary file - cannot display]',
          language: 'text',
          truncated: false,
          size: fileSize,
          isBinary: true,
        };
      }

      // Convert to string, potentially truncated
      let content = buffer.toString('utf-8');
      if (truncated) {
        content = content.slice(0, MAX_FILE_SIZE);
      }

      return {
        content,
        language: getLanguageFromPath(input.path),
        truncated,
        size: fileSize,
        isBinary: false,
      };
    }),
});
