import { Router } from 'express';
import { z } from 'zod';
import { type AppContext, createAppContext } from '@/backend/app-context';
import { HTTP_STATUS } from '@/backend/constants';
import { projectManagementService } from '@/backend/services/project-management.service';

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

interface ProjectDtoShape {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  worktreeBasePath: string;
  defaultBranch: string;
  githubOwner: string | null;
  githubRepo: string | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function serializeProject(project: ProjectDtoShape) {
  return {
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
  };
}

// ============================================================================
// Routes
// ============================================================================

export function createProjectRouter(appContext: AppContext): Router {
  const router = Router();
  const logger = appContext.services.createLogger('api:project');
  const configService = appContext.services.configService;

  /**
   * POST /api/projects/create
   * Create a new project (only repoPath required - name/slug/worktree derived)
   */
  router.post('/create', async (req, res) => {
    try {
      const validatedInput = CreateProjectSchema.parse(req.body);

      // Validate repo path
      const repoValidation = await projectManagementService.validateRepoPath(
        validatedInput.repoPath
      );
      if (!repoValidation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: 'INVALID_REPO_PATH',
            message: `Invalid repository path: ${repoValidation.error}`,
          },
        });
      }

      // Create project - name/slug/worktree derived from repoPath
      const project = await projectManagementService.create(
        { repoPath: validatedInput.repoPath },
        { worktreeBaseDir: configService.getWorktreeBaseDir() }
      );

      return res.status(HTTP_STATUS.CREATED).json({
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
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid input',
            details: error.issues,
          },
        });
      }

      logger.error('Error creating project', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
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
      const projects = await projectManagementService.list({ isArchived });

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          projects: projects.map((p) => serializeProject(p)),
        },
      });
    } catch (error) {
      logger.error('Error listing projects', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
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
      const project = await projectManagementService.findById(projectId);

      if (!project) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `Project with ID '${projectId}' not found`,
          },
        });
      }

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          ...serializeProject(project),
          workspaces: project.workspaces,
        },
      });
    } catch (error) {
      logger.error('Error getting project', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
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
      const existingProject = await projectManagementService.findById(projectId);
      if (!existingProject) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `Project with ID '${projectId}' not found`,
          },
        });
      }

      // Validate repoPath if updating
      if (validatedInput.repoPath) {
        const repoValidation = await projectManagementService.validateRepoPath(
          validatedInput.repoPath
        );
        if (!repoValidation.valid) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: {
              code: 'INVALID_REPO_PATH',
              message: `Invalid repository path: ${repoValidation.error}`,
            },
          });
        }
      }

      // Update project
      const project = await projectManagementService.update(projectId, validatedInput);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: serializeProject(project),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid input',
            details: error.issues,
          },
        });
      }

      logger.error('Error updating project', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
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
      const existingProject = await projectManagementService.findById(projectId);
      if (!existingProject) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `Project with ID '${projectId}' not found`,
          },
        });
      }

      // Archive (soft delete)
      const project = await projectManagementService.archive(projectId);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          id: project.id,
          message: 'Project archived successfully',
        },
      });
    } catch (error) {
      logger.error('Error archiving project', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
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

      const project = await projectManagementService.findById(projectId);
      if (!project) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `Project with ID '${projectId}' not found`,
          },
        });
      }

      const repoValidation = await projectManagementService.validateRepoPath(project.repoPath);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          repoPath: {
            valid: repoValidation.valid,
            error: repoValidation.error,
          },
        },
      });
    } catch (error) {
      logger.error('Error validating project', error as Error);
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  });

  return router;
}

export const projectRouter = createProjectRouter(createAppContext());
