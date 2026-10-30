import { CloverIcon } from '@phosphor-icons/react/dist/csr/Clover';
import { FlowerIcon } from '@phosphor-icons/react/dist/csr/Flower';
import { FlowerLotusIcon } from '@phosphor-icons/react/dist/csr/FlowerLotus';
import { cn } from '@/lib/utils';

export const SUBAGENT_ICONS = [
  { icon: FlowerIcon, color: 'text-amber-600 dark:text-amber-400' },
  { icon: FlowerLotusIcon, color: 'text-teal-600 dark:text-teal-300' },
  { icon: CloverIcon, color: 'text-violet-600 dark:text-violet-400' },
] as const;

export function SubagentIcon({ index, className }: { index: number; className?: string }) {
  const { icon: Icon, color } = SUBAGENT_ICONS[index % SUBAGENT_ICONS.length] ?? SUBAGENT_ICONS[0];
  return (
    <Icon
      aria-hidden="true"
      weight="duotone"
      className={cn('h-5 w-5 shrink-0', color, className)}
    />
  );
}
