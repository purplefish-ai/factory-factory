import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { AcpPlanEntry } from './reducer/types';

interface AcpPlanViewProps {
  entries: AcpPlanEntry[];
  className?: string;
}

function StatusIcon({ status }: { status: AcpPlanEntry['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    case 'in_progress':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

function PriorityBadge({ priority }: { priority: AcpPlanEntry['priority'] }) {
  const colors = {
    high: 'bg-red-500/10 text-red-600',
    medium: 'bg-yellow-500/10 text-yellow-600',
    low: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-sm font-medium', colors[priority])}>
      {priority}
    </span>
  );
}

export function AcpPlanView({ entries, className }: AcpPlanViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const completedCount = entries.filter((e) => e.status === 'completed').length;
  const totalCount = entries.length;

  return (
    <div className={cn('border rounded-md bg-muted/30', className)}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
      >
        <span>
          Plan ({completedCount}/{totalCount} completed)
        </span>
        <span className="text-xs text-muted-foreground">{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-1.5">
          {entries.map((entry, index) => (
            <div key={`${entry.content}-${index}`} className="flex items-start gap-2">
              <StatusIcon status={entry.status} />
              <div className="flex-1 min-w-0">
                <span
                  className={cn(
                    'text-sm',
                    entry.status === 'completed' && 'text-muted-foreground line-through'
                  )}
                >
                  {entry.content}
                </span>
              </div>
              <PriorityBadge priority={entry.priority} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
