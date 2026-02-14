import { FileCheck, MessageCircleQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type PendingRequestType = 'plan_approval' | 'user_question';

export function PendingRequestBadge({
  type,
  size = 'sm',
  className,
}: {
  type: PendingRequestType;
  size?: 'sm' | 'xs';
  className?: string;
}) {
  if (type === 'plan_approval') {
    return (
      <Badge
        variant="outline"
        className={cn(
          'gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
          size === 'xs' ? 'h-4 px-1 text-[10px]' : 'text-[10px]',
          className
        )}
      >
        <FileCheck className={size === 'xs' ? 'h-2 w-2' : 'h-2.5 w-2.5'} />
        Plan Approval Needed
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30',
        size === 'xs' ? 'h-4 px-1 text-[10px]' : 'text-[10px]',
        className
      )}
    >
      <MessageCircleQuestion className={size === 'xs' ? 'h-2 w-2' : 'h-2.5 w-2.5'} />
      Question Waiting
    </Badge>
  );
}
