import { describeRuleFixtures } from '../testing/rule-fixtures';

describeRuleFixtures('named-query-options', {
  rejected: [
    'trpc.project.list.useQuery(input, { refetchInterval: 10_000 });',
    'useQuery({ refetchInterval: open ? 30_000 : false });',
    'useQuery({ refetchInterval: 2 * POLL_INTERVAL_MS.activity });',
    'useQuery({ refetchInterval: (query) => (query.state.data ? false : 1000) });',
    'useQuery({ refetchInterval(query) { if (query.state.data) { return false; } return 5000; } });',
    'useQuery({ enabled, refetchOnWindowFocus: false });',
    'useQuery({ staleTime: 60_000, retry: false });',
    'useQuery({ retry: 1, retryDelay: 1000 });',
    'const previewOptions = { retry: true } as const;',
  ],
  accepted: [
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
  ],
});
