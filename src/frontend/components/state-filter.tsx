'use client';

import { TaskState } from '@prisma-gen/browser';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * State badge variants mapping
 */
export const stateVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PLANNING: 'secondary',
  PLANNED: 'secondary',
  PENDING: 'outline',
  ASSIGNED: 'default',
  IN_PROGRESS: 'default',
  REVIEW: 'default',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

interface StateFilterProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Reusable state filter component for task/epic lists
 */
export function StateFilter({ value, onChange }: StateFilterProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex gap-4 items-center">
          <label className="text-sm font-medium">Filter by state:</label>
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All States" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {Object.values(TaskState).map((state) => (
                <SelectItem key={state} value={state}>
                  {state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
