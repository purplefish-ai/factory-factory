import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
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
        <ComposerMenuTrigger
          disabled={disabled}
          aria-label={`Reasoning effort: ${displayName}`}
          title={`Reasoning effort: ${displayName}`}
          className="max-w-[12rem]"
          icon={<BrainIcon className="size-3.5 shrink-0" aria-hidden="true" />}
        >
          {displayName}
        </ComposerMenuTrigger>
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
