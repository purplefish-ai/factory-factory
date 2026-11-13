import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('query-error-handled', {
  rejected: [
    'const { data, isLoading } = trpc.project.list.useQuery();',
    'const { data, isPending } = useQuery(options);',
    'const { data, isLoading: loading } = useWorkspaceDetailQuery(id);',
    'const mail = trpc.workspace.listMail.useInfiniteQuery(input); show(mail.isLoading, mail.data);',
    'const q = trpc.a.b.useQuery(); const busy = q?.isPending;',
    'const query = useFooQuery(); const { data, isLoading } = query; show(data, isLoading);',
  ],
  accepted: [
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
  ],
});
