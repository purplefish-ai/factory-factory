// Seeding through the public tRPC API over HTTP; never a database write.
import { z } from 'zod';

const trpcResultSchema = z.object({ result: z.object({ data: z.object({ json: z.unknown() }) }) });

async function trpcMutation(backendUrl, path, input) {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
  return trpcResultSchema.parse(JSON.parse(text)).result.data.json;
}

/** One project on the seed repository, Codex as the default provider. */
export async function seed(backendUrl, repoPath) {
  const project = z
    .object({ id: z.string() })
    .parse(await trpcMutation(backendUrl, 'project.create', { repoPath }));
  await trpcMutation(backendUrl, 'userSettings.update', { defaultSessionProvider: 'CODEX' });
  return project.id;
}
