import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-oxlint-rules-')));
const binary = resolve('node_modules/.bin/oxlint');
const config = join(directory, '.oxlintrc.json');
const rules = [
  'no-await-import',
  'icon-button-name',
  'no-native-dialogs',
  'no-next-directives',
  'no-zod-any',
  'no-unsafe-json-parse-cast',
  'no-unsafe-resolver-cast',
  'no-tool-input-cast',
  'no-raw-palette-classes',
  'query-owner',
  'named-query-options',
];
const workspaceQueryOwner = 'owned/workspace-queries.ts';
const userSettingsOwner = 'owned/user-settings-queries.ts';
writeFileSync(
  config,
  JSON.stringify({
    categories: { correctness: 'off' },
    plugins: [],
    jsPlugins: [{ name: 'factory', specifier: resolve('lint-rules/factory.mjs') }],
    rules: {
      ...Object.fromEntries(rules.map((rule) => [`factory/${rule}`, 'error'])),
      'factory/query-owner': [
        'error',
        {
          groups: [
            {
              procedures: ['workspace.get', 'workspace.listForProject'],
              owners: [workspaceQueryOwner],
              helpers: 'cache',
              reason: 'plain reads bypass the reconciler',
            },
            {
              procedures: ['userSettings.get', 'userSettings.update'],
              owners: [userSettingsOwner],
              helpers: 'all',
              reason: 'its hooks share one cache strategy',
            },
          ],
        },
      ],
    },
  })
);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const reportSchema = z.object({
  diagnostics: z.array(
    z.object({
      filename: z.string(),
      code: z.string(),
      severity: z.string(),
    })
  ),
  number_of_files: z.number().int().nonnegative(),
});

describe('Oxlint project guardrails', () => {
  const rejectedSources: [string, string][] = [
    ['icon-button-name', 'const x = <Button size="icon" aria-label={""}><XIcon /></Button>;'],
    ['icon-button-name', 'const x = <Button size="icon" aria-label={``}><XIcon /></Button>;'],
    ['icon-button-name', 'const x = <button><span><XIcon /></span></button>;'],
    ['icon-button-name', 'const x = <button><Icons.Close /></button>;'],
    ['icon-button-name', 'const x = <button><Toolkit.CloseIcon /></button>;'],
    [
      'icon-button-name',
      'const x = <Button size="icon"><XIcon /><span aria-hidden>Close</span></Button>;',
    ],
    [
      'icon-button-name',
      'const x = <Button asChild size="icon"><a aria-label=""><XIcon /></a></Button>;',
    ],
    ['icon-button-name', 'const x = <Button size="icon"><PlusIcon /></Button>;'],
    ['icon-button-name', 'const x = <button><XIcon /></button>;'],
    ['icon-button-name', 'const x = <Button size="icon" />;'],
    ['icon-button-name', 'const x = <Button size="icon"><span /></Button>;'],
    [
      'icon-button-name',
      'const x = <Button size="icon"><span aria-hidden="true">Close</span></Button>;',
    ],
    ['icon-button-name', 'const x = <Button size="icon" aria-label=""><PlusIcon /></Button>;'],
    ['no-await-import', 'async function load() { return await import("./module"); }'],
    ['no-native-dialogs', 'window.confirm("Continue?");'],
    ['no-native-dialogs', 'prompt("Name", "default");'],
    ['no-native-dialogs', 'window["alert"]("Warning");'],
    ['no-next-directives', '"use client"; export const example = 1;'],
    ['no-next-directives', '"use server"; export const example = 1;'],
    ['no-zod-any', 'const schema = z.any();'],
    ['no-zod-any', 'const schema = zod.any();'],
    ['no-unsafe-json-parse-cast', 'const value = JSON.parse(input) as Response;'],
    ['no-unsafe-json-parse-cast', 'const value = JSON.parse(input) as unknown as Response;'],
    ['no-unsafe-resolver-cast', 'const callback = resolve as (value: unknown) => void;'],
    ['no-unsafe-resolver-cast', 'const callback = resolve as (value: Array<unknown>) => void;'],
    ['no-tool-input-cast', 'const todos = input.todos as Todo[] | undefined;'],
    ['no-tool-input-cast', 'const path = (input.file_path as string) ?? "";'],
    ['no-tool-input-cast', 'const offset = input?.["offset"] as number;'],
    ['no-tool-input-cast', 'const path = call.input.file_path as string;'],
    ['no-tool-input-cast', 'const payload = input as unknown as Payload;'],
    ['no-tool-input-cast', 'const todos = input!.todos as Todo[];'],
    ['no-tool-input-cast', 'const path = call.input!.file_path as string;'],
    ['no-raw-palette-classes', 'const className = "flex bg-red-500";'],
    ['no-raw-palette-classes', 'export const chip = <span className="dark:text-emerald-300" />;'],
    ['no-raw-palette-classes', 'const className = `${base} hover:border-sky-500/40`;'],
    ['no-raw-palette-classes', 'const progress = "[&>div]:bg-zinc-900";'],
    ['no-raw-palette-classes', 'const glow = "text-shadow-red-500";'],
    ['no-raw-palette-classes', 'const className = "dark:text-red-500";'],
    ['no-raw-palette-classes', 'const className = "p-2 !bg-red-500";'],
    ['no-raw-palette-classes', 'const glow = "inset-ring-amber-400/50";'],
    ['query-owner', 'const query = trpc.workspace.get.useQuery({ id });'],
    ['query-owner', 'const query = trpc.workspace.listForProject.useSuspenseQuery(input);'],
    ['query-owner', 'await utils.workspace.get.fetch({ id });'],
    ['query-owner', 'await utils.workspace.listForProject.ensureData(input);'],
    ['query-owner', 'void utils.workspace.get.prefetch({ id });'],
    ['query-owner', 'utils.workspace.listForProject.setData(input, (old) => old);'],
    ['query-owner', 'utils.workspace["get"].setData({ id }, detail);'],
    ['query-owner', 'const options = utils.workspace.get.queryOptions({ id });'],
    ['query-owner', 'const fetchDetail = utils.workspace.get.fetch;'],
    ['query-owner', "const key = getQueryKey(trpc.workspace.get, { id }, 'query');"],
    ['query-owner', 'const key = getQueryKey(trpc.workspace.listForProject);'],
    ['query-owner', 'const settings = trpc.userSettings.get.useQuery();'],
    ['query-owner', 'const update = trpc.userSettings.update.useMutation();'],
    ['query-owner', 'await utils.userSettings.get.invalidate();'],
    ['query-owner', 'const cached = utils.userSettings.get.getData();'],
    ['query-owner', 'const saved = await utils.client.userSettings.get.query();'],
    ['query-owner', 'const key = getMutationKey(trpc.userSettings.update);'],
    ['named-query-options', 'trpc.project.list.useQuery(input, { refetchInterval: 10_000 });'],
    ['named-query-options', 'useQuery({ refetchInterval: open ? 30_000 : false });'],
    ['named-query-options', 'useQuery({ refetchInterval: 2 * POLL_INTERVAL_MS.activity });'],
    [
      'named-query-options',
      'useQuery({ refetchInterval: (query) => (query.state.data ? false : 1000) });',
    ],
    [
      'named-query-options',
      'useQuery({ refetchInterval(query) { if (query.state.data) { return false; } return 5000; } });',
    ],
    ['named-query-options', 'useQuery({ enabled, refetchOnWindowFocus: false });'],
    ['named-query-options', 'useQuery({ staleTime: 60_000, retry: false });'],
    ['named-query-options', 'useQuery({ retry: 1, retryDelay: 1000 });'],
    ['named-query-options', 'const previewOptions = { retry: true } as const;'],
  ];
  const rejectedFixtures = rejectedSources.map(([rule, source], index) => ({
    rule,
    source,
    file: join(directory, `rejected-${index}.tsx`),
  }));

  const acceptedFixtures = [
    'const x = <Button size="icon"><><XIcon /><span className="sr-only">Close</span></></Button>;',
    'const x = <button><span><XIcon /></span>Close</button>;',
    'const x = <Button asChild size="icon"><a aria-label="Close"><XIcon /></a></Button>;',

    'const x = <Button size="icon" aria-label="Add workspace"><PlusIcon /></Button>;',
    'const x = <button title="Close"><XIcon /></button>;',
    'const x = <Button size="icon"><PlusIcon /><span className="sr-only">Add workspace</span></Button>;',
    'const x = <Button><PlusIcon />Add workspace</Button>;',
    'const x = <Button aria-labelledby={labelId}><PlusIcon /></Button>;',

    'import { example } from "./module";',
    'async function load() { return import("./module"); }',
    'const dialog = { confirm(value: string) { return value; } }; dialog.confirm("hello");',
    'const schema = z.unknown();',
    'const parsed = JSON.parse(input); const value = schema.parse(parsed);',
    'const callback = resolve as (value: string) => void;',
    'const parsed = parseToolInput(readToolInputSchema, input);',
    'const keys = ["file_path", "offset"] as const;',
    'const textarea = inputRef.current as HTMLTextAreaElement;',
    'const name = tool.name as string;',
    'const description = "use client";',
    'function example() { return "use server"; }',
    'const className = "bg-success/10 text-running border-destructive/30";',
    'const className = "bg-black/60 text-white";',
    'const pattern = /text-red-500/;',
    'const id = "my-text-red-500-id";',
    'const url = "/api/text-red-500";',
    'const selector = "a.text-red-500";',
    'await utils.workspace.get.invalidate({ id });',
    'await utils.workspace.listForProject.cancel(input);',
    'const cached = utils.workspace.listForProject.getData(input);',
    'const detail = await utils.client.workspace.get.query({ id }, { signal });',
    'const children = trpc.workspace.listChildren.useQuery({ id });',
    'const project = trpc.project.get.useQuery({ id });',
    "const key = getQueryKey(trpc.workspace.listChildren, { id }, 'query');",
    'const value = map.get.fetch();',
    'const options = trpc.userSettings.getProviderOptions.useQuery();',
    'const test = trpc.userSettings.testCustomCommand.useMutation();',
    'const key = getMutationKey(trpc.workspace.get);',
    'const settings = useUserSettings({ enabled });',
    'useQuery({ refetchInterval: open ? POLL_INTERVAL_MS.background : false });',
    'useQuery({ refetchInterval: (query) => (query.state.data.length > 0 ? POLL_INTERVAL_MS.external : false) });',
    'useQuery({ refetchInterval(query) { const n = items.filter((x) => x > 0).length; return n === 0 ? false : POLL_INTERVAL_MS.progress; } });',
    'useQuery({ refetchInterval: (query) => query.state.data.length > 0 && POLL_INTERVAL_MS.activity });',
    'useQuery({ refetchInterval: REVIEW_REQUESTS_POLL_MS, refetchOnWindowFocus: true });',
    'useQuery({ retry: QUERY_RETRY.costlyRead });',
    'useQuery({ retry: (count, error) => count < 1 });',
    'new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });',
    'const defaults = { queries: { retry: 0 }, mutations: { retry: false } };',
    'const step = { file: "a.ts", old_string: "retry: false" };',
  ]
    .map((source, index) => ({ source, file: join(directory, `accepted-${index}.tsx`) }))
    .concat(
      {
        // The configured owner is the one file allowed to build these options.
        source: 'utils.workspace.get.setData({ id }, detail); getQueryKey(trpc.workspace.get);',
        file: join(directory, workspaceQueryOwner),
      },
      {
        source:
          'trpc.userSettings.update.useMutation(); utils.userSettings.get.setData(undefined, saved);',
        file: join(directory, userSettingsOwner),
      }
    );

  let report: z.infer<typeof reportSchema>;
  beforeAll(() => {
    // Separate modules preserve every fixture's scope while sharing one real CLI startup.
    const fixtures = [...rejectedFixtures, ...acceptedFixtures];
    mkdirSync(join(directory, 'owned'));
    for (const { file, source } of fixtures) {
      writeFileSync(file, source);
    }
    const result = spawnSync(
      binary,
      ['--config', config, '--format', 'json', ...fixtures.map(({ file }) => file)],
      { cwd: directory, encoding: 'utf8' }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.number_of_files).toBe(fixtures.length);
    const filenames = fixtures.map(({ file }) => relative(directory, file));
    for (const diagnostic of report.diagnostics) {
      expect(filenames).toContain(diagnostic.filename);
    }
  });

  it.each(rejectedFixtures)('rejects $rule: $source', ({ rule, file }) => {
    expect(
      report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
    ).toEqual([
      { filename: relative(directory, file), code: `factory(${rule})`, severity: 'error' },
    ]);
  });

  it.each(acceptedFixtures)('permits $source', ({ file }) => {
    expect(
      report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
    ).toEqual([]);
  });
});

const paletteRuleSchema = z.tuple([
  z.literal('error'),
  z.object({ exceptions: z.record(z.string(), z.string().min(1)) }),
]);
const overridesSchema = z.object({
  overrides: z.array(
    z.object({ files: z.array(z.string()), rules: z.record(z.string(), z.unknown()) })
  ),
});

describe('raw palette class exceptions', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
  const exceptions = projectConfig.overrides.flatMap((override) => {
    const rule = override.rules['factory/no-raw-palette-classes'];
    return Array.isArray(rule) ? Object.entries(paletteRuleSchema.parse(rule)[1].exceptions) : [];
  });

  it('keeps the allowlist small, with a reason for every file', () => {
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeLessThanOrEqual(8);
    for (const [, reason] of exceptions) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(exceptions.map(([file]) => file))('%s still needs its exception', (file) => {
    // Same pattern as factory/no-raw-palette-classes in lint-rules/factory.mjs.
    expect(readFileSync(resolve(file), 'utf8')).toMatch(
      /(?<=^|[\s'"`:!])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|text-shadow|drop-shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?![\w-])/
    );
  });
});

describe('query owners', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
  const groupSchema = z.object({
    procedures: z.array(z.string()),
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
      groups.map(({ procedures, owners, helpers }) => ({ procedures, owners, helpers }))
    ).toEqual([
      {
        procedures: ['workspace.get', 'workspace.listForProject'],
        owners: [
          'src/client/lib/workspace-queries.ts',
          'src/client/lib/workspace-cache-reconciler.ts',
        ],
        helpers: 'cache',
      },
      {
        procedures: ['userSettings.get', 'userSettings.update'],
        owners: ['src/client/lib/user-settings-queries.ts'],
        helpers: 'all',
      },
    ]);
    for (const owner of groups.flatMap((group) => group.owners)) {
      expect(existsSync(resolve(owner))).toBe(true);
    }
  });
});

describe('tool input casts', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );

  it('applies to the agent activity renderers without file exceptions', () => {
    const scopes = projectConfig.overrides
      .filter((override) => override.rules['factory/no-tool-input-cast'] !== undefined)
      .map((override) => [override.files, override.rules['factory/no-tool-input-cast']]);
    expect(scopes).toEqual([[['src/client/features/chat/agent-activity/**/*.{ts,tsx}'], 'error']]);
  });
});

describe('settings section card exceptions', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
  const adminFiles = projectConfig.overrides
    .filter(
      (override) =>
        override.rules['no-restricted-imports'] === 'off' &&
        override.files.every((file) => file.startsWith('src/client/routes/admin/'))
    )
    .flatMap((override) => override.files);

  it('lets only the section shell and stat tiles build card headers', () => {
    expect(adminFiles).toEqual([
      'src/client/routes/admin/settings-section.tsx',
      'src/client/routes/admin/StatCard.tsx',
    ]);
  });

  it.each(adminFiles)('%s still needs its exception', (file) => {
    expect(readFileSync(resolve(file), 'utf8')).toMatch(
      /\b(?:CardHeader|CardTitle|CardDescription|CardAction)\b[^;]*from '@\/components\/ui\/card'/
    );
  });
});
