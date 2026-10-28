import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import {
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChatModelOption } from '@/shared/chat-capabilities';

/** Enter/click chooses the default; hover, the chevron and ArrowRight explore models. */
export function ProviderModelSubmenu({
  name,
  selected,
  model,
  options,
  loading,
  onSelect,
}: {
  name: string;
  selected: boolean;
  model?: string;
  options: { defaultModel?: string; models: readonly ChatModelOption[] };
  loading: boolean;
  onSelect: (model?: string) => void;
}) {
  const defaultLabel =
    options.models.find((entry) => entry.value === options.defaultModel)?.label ??
    options.defaultModel ??
    'Provider default';
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="relative gap-2 py-0 pr-0 pl-8 [&>svg:last-child]:hidden"
        aria-description={`Click or press Enter to select ${name}'s default model. Use the arrow to choose a model.`}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-model-submenu]')) {
            return;
          }
          event.preventDefault();
          onSelect(options.defaultModel);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(options.defaultModel);
          }
        }}
      >
        {selected && (
          <CheckIcon className="absolute left-2 size-4" aria-label="Selected provider" />
        )}
        <span className="min-w-0 flex-1 py-2">
          <span className="block">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{defaultLabel}</span>
        </span>
        <span
          data-model-submenu
          aria-hidden="true"
          className="flex w-9 self-stretch items-center justify-center border-l border-border/50"
        >
          <CaretRightIcon className="size-4" />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto">
          <DropdownMenuLabel>{name} models</DropdownMenuLabel>
          {loading && (
            <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading models…
            </div>
          )}
          <DropdownMenuRadioGroup value={selected ? (model ?? '') : ''} onValueChange={onSelect}>
            {options.models.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <span className="min-w-0 flex-1">{option.label}</span>
                {option.value === options.defaultModel && (
                  <span className="text-xs text-muted-foreground">Default</span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
