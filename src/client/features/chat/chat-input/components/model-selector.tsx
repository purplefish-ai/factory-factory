import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChatModelOption } from '@/shared/chat-capabilities';

interface ModelSelectorProps {
  selectedModel: string;
  options: ChatModelOption[];
  onChange: (model: string) => void;
  disabled?: boolean;
}

/**
 * Model selector dropdown.
 */
export function ModelSelector({ selectedModel, options, onChange, disabled }: ModelSelectorProps) {
  const currentModel = options.find((m) => m.value === selectedModel);
  const displayName = currentModel?.label ?? (selectedModel || 'Select effort');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Reasoning effort: ${displayName}`}
          title={`Reasoning effort: ${displayName}`}
          className="h-6 max-w-[12rem] gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <BrainIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{displayName}</span>
          <CaretDownIcon className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selectedModel} onValueChange={onChange}>
          {options.map((model) => (
            <DropdownMenuRadioItem key={model.value} value={model.value}>
              {model.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
