import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AVAILABLE_MODELS } from '@/lib/claude-types';

interface ModelSelectorProps {
  selectedModel: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

/**
 * Model selector dropdown.
 */
export function ModelSelector({ selectedModel, onChange, disabled }: ModelSelectorProps) {
  const currentModel = AVAILABLE_MODELS.find((m) => m.value === selectedModel);
  // biome-ignore lint/style/noNonNullAssertion: AVAILABLE_MODELS is a non-empty constant array
  const displayName = currentModel?.displayName ?? AVAILABLE_MODELS[0]!.displayName;

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
          {AVAILABLE_MODELS.map((model) => (
            <DropdownMenuRadioItem key={model.value} value={model.value}>
              {model.displayName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
