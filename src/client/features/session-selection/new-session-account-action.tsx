import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CodexAccountSummary } from '@/shared/codex-accounts';

interface ActionProps {
  onCreate: (codexAccountId?: string) => void;
  disabled?: boolean;
}
interface ActionViewProps extends ActionProps {
  accounts?: readonly Pick<CodexAccountSummary, 'id' | 'label' | 'authenticated'>[];
}
export function NewSessionAccountActionView({ accounts, onCreate, disabled }: ActionViewProps) {
  const multiple = accounts && accounts.length > 1;
  const button = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground"
      aria-label="New session"
      disabled={disabled}
      onClick={multiple ? undefined : () => onCreate(undefined)}
    >
      <PlusIcon className="h-3.5 w-3.5" />
    </Button>
  );
  if (!multiple) {
    return button;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>New Codex chat</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCreate(undefined)}>Auto</DropdownMenuItem>
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            disabled={!account.authenticated}
            onSelect={() => onCreate(account.id)}
          >
            {account.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function CodexNewSessionAction(props: ActionProps) {
  const accounts = trpc.codexAccounts.list.useQuery(undefined, { staleTime: 30_000, retry: false });
  return <NewSessionAccountActionView {...props} accounts={accounts.data} />;
}
export function NewSessionAccountAction({
  provider,
  ...props
}: ActionProps & { provider?: 'CLAUDE' | 'CODEX' }) {
  return provider === 'CODEX' ? (
    <CodexNewSessionAction {...props} />
  ) : (
    <NewSessionAccountActionView {...props} />
  );
}
