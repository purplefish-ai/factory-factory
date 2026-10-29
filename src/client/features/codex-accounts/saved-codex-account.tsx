import { trpc } from '@/client/lib/trpc';
/** This is a saved binding, deliberately not an editable new-conversation selector. */
export function SavedCodexAccount({ id }: { id: string }) {
  const accounts = trpc.codexAccounts.list.useQuery(undefined, { staleTime: 30_000, retry: false });
  const account = accounts.data?.find((account) => account.id === id);
  return (
    <span
      className="max-w-32 truncate text-xs text-muted-foreground"
      title="This chat keeps its saved Codex account"
      role="note"
      aria-label={`Saved Codex account: ${account?.label ?? 'Unavailable'}`}
    >
      {account?.label ?? 'Saved Codex account'}
    </span>
  );
}
