import { Router } from 'express';
import { z } from 'zod';
import { projectAccessor } from '../../resource_accessors/index.js';
import { configService } from '../../services/config.service.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

// Simplified - only repoPath required, name/slug/worktree derived automatically
const CreateProjectSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  repoPath: z.string().min(1).optional(),
  defaultBranch: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/projects/create
 * Create a new project (only repoPath required - name/slug/worktree derived)
 */
router.post('/create', async (req, res) => {
  try {
    const validatedInput = CreateProjectSchema.parse(req.body);

    // Validate repo path
    const repoValidation = await projectAccessor.validateRepoPath(validatedInput.repoPath);
    if (!repoValidation.valid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REPO_PATH',
          message: `Invalid repository path: ${repoValidation.error}`,
        },
      });
    }

    // Create project - name/slug/worktree derived from repoPath
    const project = await projectAccessor.create(
      { repoPath: validatedInput.repoPath },
      { worktreeBaseDir: configService.getWorktreeBaseDir() }
    );

    return res.status(201).json({
      success: true,
      data: {
        projectId: project.id,
        name: project.name,
        slug: project.slug,
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
        defaultBranch: project.defaultBranch,
        createdAt: project.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error creating project:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /api/projects/list
 * List all projects
 */
router.get('/list', async (req, res) => {
  try {
    const isArchived = req.query.isArchived === 'true';
    const projects = await projectAccessor.list({ isArchived });

    return res.status(200).json({
      success: true,
      data: {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          repoPath: p.repoPath,
          worktreeBasePath: p.worktreeBasePath,
          defaultBranch: p.defaultBranch,
          githubOwner: p.githubOwner,
          githubRepo: p.githubRepo,
          isArchived: p.isArchived,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      },
    });
  } catch (error) {
    console.error('Error listing projects:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /api/projects/:projectId
 * Get project details
 */
router.get('/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const project = await projectAccessor.findById(projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project with ID '${projectId}' not found`,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
        defaultBranch: project.defaultBranch,
        githubOwner: project.githubOwner,
        githubRepo: project.githubRepo,
        isArchived: project.isArchived,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        workspaces: project.workspaces,
      },
    });
  } catch (error) {
    console.error('Error getting project:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * PUT /api/projects/:projectId
 * Update a project
 */
router.put('/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const validatedInput = UpdateProjectSchema.parse(req.body);

    // Check project exists
    const existingProject = await projectAccessor.findById(projectId);
    if (!existingProject) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project with ID '${projectId}' not found`,
        },
      });
    }

    // Validate new repo path if provided
    if (validatedInput.repoPath) {
      const repoValidation = await projectAccessor.validateRepoPath(validatedInput.repoPath);
      if (!repoValidation.valid) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REPO_PATH',
            message: `Invalid repository path: ${repoValidation.error}`,
          },
        });
      }
    }

    const project = await projectAccessor.update(projectId, validatedInput);

    return res.status(200).json({
      success: true,
      data: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
        defaultBranch: project.defaultBranch,
        updatedAt: project.updatedAt,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error updating project:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * DELETE /api/projects/:projectId
 * Archive a project (soft delete)
 */
router.delete('/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;

    // Check project exists
    const existingProject = await projectAccessor.findById(projectId);
    if (!existingProject) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project with ID '${projectId}' not found`,
        },
      });
    }

    // Archive (soft delete)
    const project = await projectAccessor.archive(projectId);

    return res.status(200).json({
      success: true,
      data: {
        id: project.id,
        message: 'Project archived successfully',
      },
    });
  } catch (error) {
    console.error('Error archiving project:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/projects/:projectId/validate
 * Validate project repository path
 */
router.post('/:projectId/validate', async (req, res) => {
  try {
    const projectId = req.params.projectId;

    const project = await projectAccessor.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project with ID '${projectId}' not found`,
        },
      });
    }

    const repoValidation = await projectAccessor.validateRepoPath(project.repoPath);

    return res.status(200).json({
      success: true,
      data: {
        repoPath: {
          valid: repoValidation.valid,
          error: repoValidation.error,
        },
      },
    });
  } catch (error) {
    console.error('Error validating project:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export { router as projectRouter };
