import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

export type BranchInfo = {
  name: string;
  displayName: string;
  refType: 'local' | 'remote';
};

export function ResumeBranchDialog({
  open,
  onOpenChange,
  branches,
  isLoading,
  isSubmitting,
  onSelectBranch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: BranchInfo[];
  isLoading: boolean;
  isSubmitting: boolean;
  onSelectBranch: (branch: BranchInfo) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search branches..." />
      <CommandList>
        {isLoading && <CommandEmpty>Loading branches...</CommandEmpty>}
        {!isLoading && branches.length === 0 && <CommandEmpty>No branches found.</CommandEmpty>}
        {!isLoading && branches.length > 0 && (
          <CommandGroup heading="Branches">
            {branches.map((branch) => (
              <CommandItem
                key={branch.name}
                value={branch.displayName}
                onSelect={() => onSelectBranch(branch)}
                disabled={isSubmitting}
              >
                <span className="font-mono text-sm">{branch.displayName}</span>
                {branch.refType === 'remote' && (
                  <span className="ml-auto text-xs text-muted-foreground">remote</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
