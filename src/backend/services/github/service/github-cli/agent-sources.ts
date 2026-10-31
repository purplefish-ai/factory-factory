import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';

const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  has_issues: z.boolean(),
});
const labelsSchema = z.array(z.array(z.object({ name: z.string().min(1) })));

export async function getAgentRepository(
  repository: string,
  read: (args: string[]) => Promise<{ stdout: string }>
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new ApplicationError('INVALID_INPUT', 'Invalid GitHub repository.');
  }
  try {
    const [details, labels] = await Promise.all([
      read(['api', `repos/${repository}`]),
      read(['api', `repos/${repository}/labels?per_page=100`, '--paginate', '--slurp']),
    ]);
    const repo = repositorySchema.parse(JSON.parse(details.stdout));
    if (!repo.has_issues) {
      throw new Error('Issues disabled');
    }
    return {
      id: String(repo.id),
      name: repo.full_name,
      labels: labelsSchema
        .parse(JSON.parse(labels.stdout))
        .flat()
        .map((label) => label.name),
    };
  } catch {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Could not read this GitHub repository and its labels. Check gh authentication and repository access.'
    );
  }
}
