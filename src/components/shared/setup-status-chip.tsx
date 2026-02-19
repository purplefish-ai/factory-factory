import { Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceStatus } from '@/shared/core';

interface SetupStatusChipProps {
  status: WorkspaceStatus;
  size?: 'sm' | 'md';
  className?: string;
}

export function SetupStatusChip({ status, size = 'sm', className }: SetupStatusChipProps) {
  if (status !== 'NEW' && status !== 'PROVISIONING') {
    return null;
  }

  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  const iconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm font-medium uppercase tracking-wide bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
        sizeClasses,
        className
      )}
    >
      <Circle className={cn(iconSize, 'animate-pulse')} />
      Setting up
    </span>
  );
}
