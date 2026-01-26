import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { gitCommand } from '../lib/shell.js';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor.js';
import { publicProcedure, router } from './trpc.js';

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
 * Validate that a file path doesn't escape the worktree directory
 */
function isPathSafe(worktreePath: string, filePath: string): boolean {
  // Reject paths with ..
  if (filePath.includes('..')) {
    return false;
  }

  // Resolve the full path and ensure it's within the worktree
  const fullPath = path.resolve(worktreePath, filePath);
  const normalizedWorktree = path.resolve(worktreePath);

  return fullPath.startsWith(normalizedWorktree + path.sep) || fullPath === normalizedWorktree;
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
    .mutation(({ input }) => {
      return workspaceAccessor.create(input);
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
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return workspaceAccessor.archive(input.id);
  }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
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
      if (!isPathSafe(workspace.worktreePath, input.filePath)) {
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

      if (!workspace.worktreePath) {
        return { entries: [] };
      }

      const relativePath = input.path ?? '';

      // Validate path is safe
      if (relativePath && !isPathSafe(workspace.worktreePath, relativePath)) {
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

        return { entries };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { entries: [] };
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
      if (!isPathSafe(workspace.worktreePath, input.path)) {
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
