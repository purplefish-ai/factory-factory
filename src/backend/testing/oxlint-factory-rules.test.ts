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
  'use-pending-prop',
  'no-raw-spinner',
  'no-direct-web-storage',
  'named-query-options',
  'query-error-handled',
  'no-arbitrary-font-size',
  'use-status-callout',
  'no-forward-ref',
  'no-render-ref-write',
  'no-state-sync-effect',
  'button-icon-size',
  'button-size-variant',
  'icon-button-tooltip',
  'tooltip-provider-root',
  'focus-ring',
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
    [
      'button-icon-size',
      'const x = <Button size="sm"><PlayIcon className="h-3 w-3" />Run</Button>;',
    ],
    [
      'button-icon-size',
      'const x = <Button>{busy ? <XIcon className="mr-1 md:w-4" /> : null}Go</Button>;',
    ],
    [
      'button-icon-size',
      'const x = <IconButton label="Close"><span><XIcon className="h-5 w-5" /></span></IconButton>;',
    ],
    [
      'button-size-variant',
      'const x = <Button size="icon" className="h-6 w-6" aria-label="Close"><XIcon /></Button>;',
    ],
    [
      'button-size-variant',
      'const x = <Button size="sm" className={cn("md:h-8", x)}>Run</Button>;',
    ],
    [
      'button-size-variant',
      'const x = <IconButton label="Close" className="size-7"><XIcon /></IconButton>;',
    ],
    [
      'icon-button-tooltip',
      'const x = <Tooltip><TooltipTrigger asChild><Button size="icon" aria-label="Close"><XIcon /></Button></TooltipTrigger><TooltipContent>Close</TooltipContent></Tooltip>;',
    ],
    [
      'icon-button-tooltip',
      'const x = <TooltipTrigger asChild><DropdownMenuTrigger asChild><Button size="icon-xs" aria-label="More"><DotsIcon /></Button></DropdownMenuTrigger></TooltipTrigger>;',
    ],
    ['icon-button-tooltip', 'const x = <Button size="icon-sm" title="Close"><XIcon /></Button>;'],
    [
      'icon-button-tooltip',
      'const x = <TooltipTrigger asChild><Button size="icon" title="Close"><XIcon /></Button></TooltipTrigger>;',
    ],
    ['icon-button-name', 'const x = <IconButton label=""><XIcon /></IconButton>;'],
    ['icon-button-name', 'const x = <IconButton label={``}><XIcon /></IconButton>;'],
    ['tooltip-provider-root', 'const x = <TooltipProvider><Tooltip /></TooltipProvider>;'],
    [
      'focus-ring',
      'const c = "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";',
    ],
    ['focus-ring', 'const x = <a className="hover:underline focus-visible:outline-ring" />;'],
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
    [
      'use-pending-prop',
      'const x = <Button disabled={saving}>{saving && <Spinner aria-hidden />}Save</Button>;',
    ],
    [
      'use-pending-prop',
      'const x = <Button size="icon" aria-label="Run">{busy ? <Spinner /> : <PlayIcon />}</Button>;',
    ],
    [
      'use-pending-prop',
      'const x = <DropdownMenuItem>{busy ? <Spinner /> : <SyncIcon />}Sync</DropdownMenuItem>;',
    ],
    ['use-pending-prop', 'const x = <Button><><Spinner />Loading</></Button>;'],
    ['no-raw-spinner', 'const x = <CircleNotchIcon className="h-4 w-4 animate-spin" />;'],
    ['no-raw-spinner', 'const x = <Icon className={cn("size-3", spin && "animate-spin")} />;'],
    ['no-raw-spinner', 'const className = "motion-safe:animate-spin";'],
    ['no-raw-spinner', 'const x = <SpinnerGapIcon aria-hidden />;'],
    ['no-raw-spinner', 'const className = `p-2 animate-spin`;'],
    ['no-direct-web-storage', 'const value = localStorage.getItem("key");'],
    ['no-direct-web-storage', 'window.localStorage.setItem("key", "value");'],
    ['no-direct-web-storage', 'sessionStorage.removeItem("key");'],
    ['no-direct-web-storage', 'const storage = globalThis["sessionStorage"];'],
    [
      'no-direct-web-storage',
      'const area = typeof window === "undefined" ? null : window.localStorage;',
    ],
    ['no-direct-web-storage', 'read({ localStorage });'],
    ['no-direct-web-storage', 'const storage = globalThis[`sessionStorage`];'],
    ['no-direct-web-storage', 'const { localStorage: store } = window;'],
    ['no-direct-web-storage', 'const { localStorage } = window;'],
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
    ['query-error-handled', 'const { data, isLoading } = trpc.project.list.useQuery();'],
    ['query-error-handled', 'const { data, isPending } = useQuery(options);'],
    ['query-error-handled', 'const { data, isLoading: loading } = useWorkspaceDetailQuery(id);'],
    [
      'query-error-handled',
      'const mail = trpc.workspace.listMail.useInfiniteQuery(input); show(mail.isLoading, mail.data);',
    ],
    ['query-error-handled', 'const q = trpc.a.b.useQuery(); const busy = q?.isPending;'],
    [
      'query-error-handled',
      'const query = useFooQuery(); const { data, isLoading } = query; show(data, isLoading);',
    ],
    ['no-arbitrary-font-size', 'const x = <span className="text-[10px] uppercase" />;'],
    ['no-arbitrary-font-size', 'const className = "md:text-[11px]";'],
    ['no-arbitrary-font-size', 'const className = `p-1 text-[0.8rem]`;'],
    ['no-arbitrary-font-size', 'const className = cn("!text-[1.5em]", active && "font-medium");'],
    [
      'use-status-callout',
      'const x = <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3" />;',
    ],
    ['use-status-callout', 'const className = "bg-warning/10 border-b border-warning/20";'],
    [
      'use-status-callout',
      'const className = `border border-success-accent/50 bg-success-accent/15`;',
    ],
    ['use-status-callout', 'const className = "dark:bg-info/10 dark:border-info/30 px-2";'],
    ['use-status-callout', 'const meta = { className: "text-info border-info bg-info/10" };'],
    ['no-forward-ref', 'const Item = forwardRef(function Item(props, ref) { return null; });'],
    ['no-forward-ref', 'const Item = React.forwardRef((props, ref) => null);'],
    [
      'no-render-ref-write',
      'function Panel() { const ref = useRef(0); ref.current = 1; return null; }',
    ],
    [
      'no-render-ref-write',
      'function useLatest(value) { const latest = useRef(value); latest.current = value; return latest; }',
    ],
    [
      'no-render-ref-write',
      'const Row = memo(function Row() { const renders = useRef(0); renders.current++; return null; });',
    ],
    [
      'no-render-ref-write',
      'const usePrevious = (value) => { const previous = useRef(value); if (previous.current !== value) { previous.current = value; } };',
    ],
    [
      'no-state-sync-effect',
      'function Panel({ id }) { const [tab, setTab] = useState("info"); useEffect(() => { setTab("info"); }, [id]); return null; }',
    ],
    [
      'no-state-sync-effect',
      'useEffect(() => { if (!open) { return; } setIndex(0); setCount((count) => count + 1); }, [open]);',
    ],
    [
      'no-render-ref-write',
      'function Panel() { const last = useRef(null); last.current ||= value; return null; }',
    ],
    [
      'no-render-ref-write',
      'function Panel() { const last = useRef(null); if (last.current === null) { init(); } else { last.current = value; } return null; }',
    ],
    [
      'no-render-ref-write',
      'function useRows(rows) { const seen = useRef(0); return useMemo(() => { seen.current = rows.length; return rows; }, [rows]); }',
    ],
    ['no-state-sync-effect', 'React.useLayoutEffect(() => setSelected(items[0]), [items]);'],
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
    'const x = <Button size="sm"><PlayIcon />Run</Button>;',
    'const x = <Button size="sm"><PlayIcon className="size-3 shrink-0" />Run</Button>;',
    'const x = <Button className="w-full sm:w-auto">Go</Button>;',
    'const x = <Button className="w-1/2">Go</Button>;',
    'const x = <IconButton label={label}><XIcon /></IconButton>;',
    'const x = <Button variant="link" className="h-auto p-0">More</Button>;',
    'const x = <Button className="min-w-0 max-w-[14rem] sm:w-[160px]">Go</Button>;',
    'const x = <div className="h-6 w-6"><XIcon className="h-3 w-3" /></div>;',
    'const x = <IconButton label="Close" size="icon-xs"><XIcon /></IconButton>;',
    'const x = <Tooltip><TooltipTrigger asChild><Button size="sm">Archive</Button></TooltipTrigger></Tooltip>;',
    'const x = <Button size="sm" title="Archive every workspace">Archive</Button>;',
    'const c = "focus-ring focus-visible:ring-inset";',
    'const c = "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";',

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
    'const x = <Button pending={saving} pendingLabel="Saving…">Save</Button>;',
    'const x = <div>{busy && <Spinner aria-hidden />}<Button>Save</Button></div>;',
    'const x = <DropdownMenuItem pending={busy}><SyncIcon />Sync</DropdownMenuItem>;',
    'const x = <Spinner className="size-3" aria-hidden />;',
    'const className = "animate-spin-slow animate-pulse";',
    'const name = "no-animate-spin";',
    'const value = readStorageItem("key");',
    'const fromRecord = record.localStorage;',
    'const areas = { localStorage: "local", sessionStorage: "session" } as const;',
    'const kind: "localStorage" | "sessionStorage" = "localStorage";',
    'const value = storage.getItem("key"); type Reader = Pick<Storage, "getItem">;',
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
    'const { data, isLoading, error } = trpc.project.list.useQuery();',
    'const { data, isPending, isError } = useQuery(options);',
    'const { data, isLoading, status } = useProjectWorkspaceQuery(id);',
    'const { data } = trpc.project.list.useQuery();',
    'const { data, isFetching, refetch } = trpc.project.list.useQuery();',
    'const { data, isLoading } = trpc.project.list.useSuspenseQuery();',
    'const { isLoading, ...query } = trpc.project.list.useQuery();',
    'const { isPending } = trpc.project.create.useMutation();',
    'const q = trpc.a.b.useQuery(); if (q.isLoading) { show(q.error); }',
    'const query = useFooQuery(); const { isLoading, error } = query; show(isLoading, error);',
    'const q = trpc.a.b.useQuery(); const busy = q.isLoading; const el = <QueryState query={q} />;',
    'const className = "text-2xs text-xs text-[var(--size)] w-[10px] leading-[11px]";',
    'const className = "text-[#ff0000] text-[color:var(--x)]";',
    'const path = "/docs/text-[10px]-guide";',
    // Hover, focus and data-state tints, a tint without a status border, a
    // status border without a tint and mixed tokens are not callouts.
    'const className = "border-warning/40 text-warning hover:bg-warning/10";',
    'const className = "border-destructive/30 focus:bg-destructive/10 data-[state=open]:bg-destructive/10";',
    'const className = "border-b bg-destructive/10 px-4 py-2";',
    'const className = "border-running-accent/70 dark:border-running/40";',
    'const className = "border-transparent bg-success-accent/15 text-success dark:bg-success/10";',
    'const className = "bg-primary/10 border-primary/15";',
    'function Item({ ref }) { return <button ref={ref} />; }',
    'function Panel() { const cache = useRef(null); if (cache.current === null) { cache.current = new Map(); } return null; }',
    'function Panel() { const cache = useRef(null); cache.current ??= new Map(); return null; }',
    'function Panel() { const count = useRef(0); useEffect(() => { count.current = 1; }); const onClick = () => { count.current += 1; }; return null; }',
    'function resetScope(scope) { scope.current = null; }',
    'useEffect(() => { setWidth(container.current.offsetWidth); }, [items]);',
    'useEffect(() => { setReady(true); }, []);',
    'useEffect(() => { const timer = setTimeout(() => setValue(next), 300); return () => clearTimeout(timer); }, [next]);',
    'useEffect(() => { toast.error(error); setOpen(false); }, [error]);',
    'useEffect(() => { setValue(readStoredValue(key)); }, [key]);',
    'useEffect(() => { if (!enabled) { return; } }, [enabled]);',
    'useEffect(() => { setTimeout(flush, delay); }, [delay]);',
    'function useRows(rows) { const seen = useRef(0); const onClick = useCallback(() => { seen.current = rows.length; }, [rows]); return onClick; }',
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

const exceptionRuleSchema = z.tuple([
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
    return Array.isArray(rule) ? Object.entries(exceptionRuleSchema.parse(rule)[1].exceptions) : [];
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

describe.each([
  'use-pending-prop',
  'no-raw-spinner',
  'no-direct-web-storage',
  'no-arbitrary-font-size',
  'use-status-callout',
  'no-render-ref-write',
  'no-state-sync-effect',
  'button-icon-size',
  'button-size-variant',
  'icon-button-tooltip',
  'tooltip-provider-root',
  'focus-ring',
])('factory/%s exceptions', (rule) => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
  const exceptions = projectConfig.overrides.flatMap((override) => {
    const setting = override.rules[`factory/${rule}`];
    return Array.isArray(setting)
      ? Object.entries(exceptionRuleSchema.parse(setting)[1].exceptions)
      : [];
  });

  it('gives every file a reason', () => {
    for (const [, reason] of exceptions) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.runIf(exceptions.length > 0)('still needs every exception', () => {
    // Lint the listed files with the rule and no exceptions: each must still report.
    const ruleConfig = join(directory, `${rule}.oxlintrc.json`);
    writeFileSync(
      ruleConfig,
      JSON.stringify({
        categories: { correctness: 'off' },
        plugins: [],
        jsPlugins: [{ name: 'factory', specifier: resolve('lint-rules/factory.mjs') }],
        rules: { [`factory/${rule}`]: 'error' },
      })
    );
    const files = exceptions.map(([file]) => file);
    const result = spawnSync(binary, ['--config', ruleConfig, '--format', 'json', ...files], {
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const reported = new Set(
      reportSchema
        .parse(JSON.parse(result.stdout))
        .diagnostics.filter(({ code }) => code === `factory(${rule})`)
        .map(({ filename }) => filename)
    );
    expect(files.filter((file) => !reported.has(file))).toEqual([]);
  });
});

describe('web storage access', () => {
  it('is limited to the shared storage module and exempts only tests', () => {
    const overrides = overridesSchema.parse(
      JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
    ).overrides;
    const scopes = overrides
      .filter((override) => override.rules['factory/no-direct-web-storage'] !== undefined)
      .map((override) => [override.files, override.rules['factory/no-direct-web-storage']]);
    expect(scopes).toEqual([
      [
        ['src/client/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
        [
          'error',
          {
            exceptions: {
              'src/client/lib/browser-storage.ts': expect.any(String),
            },
          },
        ],
      ],
      [['**/*.test.ts', '**/*.test.tsx'], 'off'],
    ]);
  });
});

describe('query owners', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
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
    ]);
    for (const group of groups) {
      expect(group.owners).toContain(group.use);
    }
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

describe('forwardRef restriction', () => {
  const projectConfig = z
    .object({ rules: z.record(z.string(), z.unknown()) })
    .and(overridesSchema)
    .parse(JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8')));

  it('applies everywhere except the shadcn/ui primitives', () => {
    expect(projectConfig.rules['factory/no-forward-ref']).toBe('error');
    expect(
      projectConfig.overrides
        .filter((override) => override.rules['factory/no-forward-ref'] !== undefined)
        .map((override) => [override.files, override.rules['factory/no-forward-ref']])
    ).toEqual([[['src/components/ui/**/*.{ts,tsx}'], 'off']]);
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

describe('settings section card restriction', () => {
  const restriction = overridesSchema
    .parse(JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8')))
    .overrides.find((override) => override.files.includes('src/client/routes/admin/**/*.tsx'))
    ?.rules['no-restricted-imports'];
  const fixtures = {
    rejected: "import { CardHeader, CardTitle } from '@/components/ui/card';",
    accepted: "import { Card, CardContent } from '@/components/ui/card';",
  };

  it('rejects card header parts and allows the card body with the project options', () => {
    expect(restriction).toBeDefined();
    const ruleDirectory = mkdtempSync(join(directory, 'card-'));
    const ruleConfig = join(ruleDirectory, '.oxlintrc.json');
    writeFileSync(
      ruleConfig,
      JSON.stringify({
        categories: { correctness: 'off' },
        plugins: [],
        rules: { 'no-restricted-imports': restriction },
      })
    );
    const files = Object.entries(fixtures).map(([name, source]) => {
      const file = join(ruleDirectory, `${name}.tsx`);
      writeFileSync(file, source);
      return file;
    });
    const result = spawnSync(binary, ['--config', ruleConfig, '--format', 'json', ...files], {
      cwd: ruleDirectory,
      encoding: 'utf8',
    });
    const diagnostics = reportSchema.parse(JSON.parse(result.stdout)).diagnostics;
    expect(diagnostics.map(({ filename, code }) => [filename, code])).toEqual([
      ['rejected.tsx', 'eslint(no-restricted-imports)'],
      ['rejected.tsx', 'eslint(no-restricted-imports)'],
    ]);
  });
});
