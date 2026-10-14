import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export interface PRRecipientChoice {
  id: string;
  name: string | null;
  provider: string;
}
export function PRRecipientPicker({
  candidates,
  onSelect,
  onCancel,
  pending,
}: {
  candidates: PRRecipientChoice[];
  onSelect(id: string): void;
  onCancel(): void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose the main conversation</DialogTitle>
          <DialogDescription>
            PR updates will queue here for its next turn, using that conversation’s model and
            permissions.
          </DialogDescription>
        </DialogHeader>
        {candidates.length ? (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger aria-label="Main conversation">
              <SelectValue placeholder="Choose a conversation" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name ?? c.id} · {c.provider}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p>Create a conversation in this workspace, then enable PR updates.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!selected || pending} onClick={() => onSelect(selected)}>
            Enable PR updates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
