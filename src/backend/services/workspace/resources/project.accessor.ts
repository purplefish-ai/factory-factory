import { prisma } from '@/backend/db';
import type { IssueProvider } from '@/shared/core/enums';
import type { IssueTrackerConfig } from '@/shared/schemas/issue-tracker-config.schema';
import { Prisma, type Project } from '@prisma-gen/client';

type ProjectWithWorkspaces = Prisma.ProjectGetPayload<{ include: { workspaces: true } }>;

interface CreateProjectInput {
  repoPath: string;
  defaultBranch: string;
  githubOwner: string | null;
  githubRepo: string | null;
  startupScriptCommand: string | null;
  startupScriptPath: string | null;
  startupScriptTimeout: number;
}

interface ProjectIdentity {
  name: string;
  slug: string;
  worktreeBasePath: string;
}

interface UpdateProjectInput {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubOwner?: string;
  githubRepo?: string;
  isArchived?: boolean;
  // Startup script configuration
  startupScriptCommand?: string | null;
  startupScriptPath?: string | null;
  startupScriptTimeout?: number;
  // Issue provider configuration
  issueProvider?: IssueProvider;
  issueTrackerConfig?: IssueTrackerConfig | null;
}

interface ListProjectsFilters {
  isArchived?: boolean;
  limit?: number;
  offset?: number;
}

function projectUpdateData({ issueTrackerConfig, ...rest }: UpdateProjectInput) {
  return {
    ...rest,
    ...(issueTrackerConfig !== undefined && {
      issueTrackerConfig: issueTrackerConfig === null ? Prisma.JsonNull : issueTrackerConfig,
    }),
  };
}

class ProjectAccessor {
  /** Keep candidate allocation and uniqueness handling beside the insert. */
  async create(
    data: CreateProjectInput,
    allocateIdentity: (attempt: number) => ProjectIdentity
  ): Promise<Project> {
    for (let attempt = 1; attempt <= 100; attempt++) {
      const identity = allocateIdentity(attempt);
      try {
        return await prisma.project.create({ data: { ...data, ...identity } });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Unique constraint') &&
          error.message.includes('slug')
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unable to create project: too many projects with similar names');
  }

  findById(id: string): Promise<ProjectWithWorkspaces | null> {
    return prisma.project.findUnique({
      where: { id },
      include: {
        workspaces: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  findBySlug(slug: string): Promise<ProjectWithWorkspaces | null> {
    return prisma.project.findUnique({
      where: { slug },
      include: {
        workspaces: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  update(id: string, data: UpdateProjectInput): Promise<Project> {
    return prisma.project.update({ where: { id }, data: projectUpdateData(data) });
  }

  /** Match both observed nullable fields in the write itself, returning its raw row. */
  async updateIfStartupUnchanged(
    id: string,
    expected: Pick<Project, 'startupScriptCommand' | 'startupScriptPath'>,
    data: UpdateProjectInput
  ): Promise<Project | null> {
    const [written] = await prisma.project.updateManyAndReturn({
      where: {
        id,
        startupScriptCommand: expected.startupScriptCommand,
        startupScriptPath: expected.startupScriptPath,
      },
      data: projectUpdateData(data),
    });
    return written ?? null;
  }

  list(filters?: ListProjectsFilters) {
    const where: Prisma.ProjectWhereInput = {};

    if (filters?.isArchived !== undefined) {
      where.isArchived = filters.isArchived;
    }

    return prisma.project.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: {
            workspaces: {
              where: { status: { notIn: ['ARCHIVING', 'ARCHIVED'] } },
            },
          },
        },
      },
    });
  }

  archive(id: string): Promise<Project> {
    return prisma.project.update({
      where: { id },
      data: { isArchived: true },
    });
  }
}

export const projectAccessor = new ProjectAccessor();
