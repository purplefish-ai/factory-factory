import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeRuleFixtures, readProjectConfig, repositoryRoot } from '../testing/rule-fixtures';

const workspaceQueryOwner = 'owned/workspace-queries.ts';
const userSettingsOwner = 'owned/user-settings-queries.ts';

describeRuleFixtures('query-owner', {
  options: {
    groups: [
      {
        procedures: ['workspace.get', 'workspace.listForProject'],
        use: workspaceQueryOwner,
        owners: [workspaceQueryOwner],
        helpers: 'cache',
        reason: 'plain reads bypass the reconciler',
      },
      {
        procedures: ['userSettings.get', 'userSettings.update'],
        use: userSettingsOwner,
        owners: [userSettingsOwner],
        helpers: 'all',
        reason: 'its hooks share one cache strategy',
      },
      {
        procedures: ['userSettings.getProviderOptions'],
        use: userSettingsOwner,
        owners: [userSettingsOwner],
        helpers: 'cache',
        reason: 'its readers share one stale time',
      },
    ],
  },
  rejected: [
    'const query = trpc.workspace.get.useQuery({ id });',
    'const query = trpc.workspace.listForProject.useSuspenseQuery(input);',
    'await utils.workspace.get.fetch({ id });',
    'await utils.workspace.listForProject.ensureData(input);',
    'void utils.workspace.get.prefetch({ id });',
    'utils.workspace.listForProject.setData(input, (old) => old);',
    'utils.workspace["get"].setData({ id }, detail);',
    'const options = utils.workspace.get.queryOptions({ id });',
    'const fetchDetail = utils.workspace.get.fetch;',
    "const key = getQueryKey(trpc.workspace.get, { id }, 'query');",
    'const key = getQueryKey(trpc.workspace.listForProject);',
    'const settings = trpc.userSettings.get.useQuery();',
    'const update = trpc.userSettings.update.useMutation();',
    'await utils.userSettings.get.invalidate();',
    'const cached = utils.userSettings.get.getData();',
    'const saved = await utils.client.userSettings.get.query();',
    'const key = getMutationKey(trpc.userSettings.update);',
    'const options = trpc.userSettings.getProviderOptions.useQuery();',
  ],
  accepted: [
    'await utils.workspace.get.invalidate({ id });',
    'await utils.workspace.listForProject.cancel(input);',
    'const cached = utils.workspace.listForProject.getData(input);',
    'const detail = await utils.client.workspace.get.query({ id }, { signal });',
    'const children = trpc.workspace.listChildren.useQuery({ id });',
    'const project = trpc.project.get.useQuery({ id });',
    "const key = getQueryKey(trpc.workspace.listChildren, { id }, 'query');",
    'const value = map.get.fetch();',
    'await utils.userSettings.getProviderOptions.invalidate();',
    'const options = useProviderOptions(undefined, { enabled });',
    'const test = trpc.userSettings.testCustomCommand.useMutation();',
    'const key = getMutationKey(trpc.workspace.get);',
    'const settings = useUserSettings({ enabled });',
    {
      // The configured owner is the one file allowed to build these options.
      source: 'utils.workspace.get.setData({ id }, detail); getQueryKey(trpc.workspace.get);',
      file: workspaceQueryOwner,
    },
    {
      source:
        'trpc.userSettings.update.useMutation(); utils.userSettings.get.setData(undefined, saved); trpc.userSettings.getProviderOptions.useQuery();',
      file: userSettingsOwner,
    },
  ],
});

describe('query owners', () => {
  const projectConfig = readProjectConfig();
  const groupSchema = z.object({
    procedures: z.array(z.string()),
    use: z.string(),
    owners: z.array(z.string()),
    helpers: z.enum(['cache', 'all']),
    reason: z.string().min(20),
  });
  const groups = projectConfig.overrides.flatMap((override) => {
    const rule = override.rules['factory/query-owner'];
    return Array.isArray(rule)
      ? z.tuple([z.literal('error'), z.object({ groups: z.array(groupSchema) })]).parse(rule)[1]
          .groups
      : [];
  });

  it('names one owner module for each guarded procedure group', () => {
    expect(
      groups.map(({ procedures, use, owners, helpers }) => ({ procedures, use, owners, helpers }))
    ).toEqual([
      {
        procedures: ['workspace.get', 'workspace.listForProject'],
        use: 'src/client/lib/workspace-queries.ts',
        owners: [
          'src/client/lib/workspace-queries.ts',
          'src/client/lib/workspace-cache-reconciler.ts',
        ],
        helpers: 'cache',
      },
      {
        procedures: ['userSettings.get', 'userSettings.update'],
        use: 'src/client/lib/user-settings-queries.ts',
        owners: ['src/client/lib/user-settings-queries.ts'],
        helpers: 'all',
      },
      {
        procedures: ['userSettings.getProviderOptions'],
        use: 'src/client/lib/user-settings-queries.ts',
        owners: ['src/client/lib/user-settings-queries.ts'],
        helpers: 'cache',
      },
    ]);
    for (const group of groups) {
      expect(group.owners).toContain(group.use);
    }
    for (const owner of groups.flatMap((group) => group.owners)) {
      expect(existsSync(join(repositoryRoot, owner))).toBe(true);
    }
  });
});
