import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
  const displayName = currentModel?.label ?? options[0]?.label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {displayName}
          <ChevronDown className="h-3 w-3" />
        </Button>
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
