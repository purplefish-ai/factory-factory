import { UserCircleIcon } from '@phosphor-icons/react/dist/csr/UserCircle';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CodexAccountSummary } from '@/shared/codex-accounts';

export interface CodexAccountPickerProps {
  accounts: readonly (Pick<CodexAccountSummary, 'id' | 'label' | 'authenticated' | 'enabled'> &
    Partial<Pick<CodexAccountSummary, 'kind'>>)[];
  value?: string;
  disabled?: boolean;
  onChange: (id: string | undefined) => void;
}
const AUTO = '__auto__';
export function CodexAccountPicker({
  accounts,
  value,
  disabled,
  onChange,
}: CodexAccountPickerProps) {
  const label = value
    ? (accounts.find((account) => account.id === value)?.label ?? 'Saved account')
    : 'Auto';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ComposerMenuTrigger
          disabled={disabled}
          className="max-w-32 shrink-0"
          aria-label={`Codex account: ${label}`}
          icon={<UserCircleIcon className="size-3.5" aria-hidden="true" />}
        >
          {label}
        </ComposerMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Codex account</DropdownMenuLabel>
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Auto chooses an available account for this new chat.
        </p>
        <DropdownMenuRadioGroup
          value={value ?? AUTO}
          onValueChange={(id) => onChange(id === AUTO ? undefined : id)}
        >
          <DropdownMenuRadioItem value={AUTO}>Auto</DropdownMenuRadioItem>
          {accounts.map((account) => (
            <DropdownMenuRadioItem
              key={account.id}
              value={account.id}
              disabled={!account.authenticated}
              title={
                account.authenticated
                  ? account.enabled
                    ? 'Included in Auto'
                    : 'Manual selection only'
                  : account.kind === 'NATIVE_DEFAULT'
                    ? 'Run ff codex login in your terminal'
                    : 'Sign in from Settings'
              }
            >
              {account.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
