import { ComposerMenuTrigger } from '@/client/components/composer-menu-trigger';
import {
  DropdownMenu,
  DropdownMenuContent,
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
        <ComposerMenuTrigger disabled={disabled} className="max-w-[12rem]">
          {displayName}
        </ComposerMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
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
