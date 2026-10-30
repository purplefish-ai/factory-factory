import { AcornIcon } from '@phosphor-icons/react/dist/csr/Acorn';
import { ButterflyIcon } from '@phosphor-icons/react/dist/csr/Butterfly';
import { CactusIcon } from '@phosphor-icons/react/dist/csr/Cactus';
import { CloverIcon } from '@phosphor-icons/react/dist/csr/Clover';
import { FlowerIcon } from '@phosphor-icons/react/dist/csr/Flower';
import { FlowerLotusIcon } from '@phosphor-icons/react/dist/csr/FlowerLotus';
import { LeafIcon } from '@phosphor-icons/react/dist/csr/Leaf';
import { PlantIcon } from '@phosphor-icons/react/dist/csr/Plant';
import { PottedPlantIcon } from '@phosphor-icons/react/dist/csr/PottedPlant';
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun';
import { TreeIcon } from '@phosphor-icons/react/dist/csr/Tree';
import { TreeEvergreenIcon } from '@phosphor-icons/react/dist/csr/TreeEvergreen';
import { cn } from '@/lib/utils';

export const SUBAGENT_ICONS = [
  { icon: FlowerIcon, color: 'text-amber-600 dark:text-amber-400' },
  { icon: FlowerLotusIcon, color: 'text-teal-600 dark:text-teal-300' },
  { icon: CloverIcon, color: 'text-violet-600 dark:text-violet-400' },
  { icon: AcornIcon, color: 'text-green-600 dark:text-green-400' },
  { icon: ButterflyIcon, color: 'text-pink-600 dark:text-pink-400' },
  { icon: CactusIcon, color: 'text-lime-600 dark:text-lime-400' },
  { icon: LeafIcon, color: 'text-emerald-600 dark:text-emerald-400' },
  { icon: PlantIcon, color: 'text-cyan-600 dark:text-cyan-400' },
  { icon: PottedPlantIcon, color: 'text-orange-600 dark:text-orange-400' },
  { icon: SunIcon, color: 'text-yellow-600 dark:text-yellow-400' },
  { icon: TreeIcon, color: 'text-blue-600 dark:text-blue-400' },
  { icon: TreeEvergreenIcon, color: 'text-rose-600 dark:text-rose-400' },
] as const;

export function SubagentIcon({ index, className }: { index: number; className?: string }) {
  const entry = SUBAGENT_ICONS[index];
  if (!entry) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums text-muted-foreground',
          className
        )}
      >
        {index + 1}
      </span>
    );
  }
  const { icon: Icon, color } = entry;
  return (
    <Icon
      aria-hidden="true"
      weight="duotone"
      className={cn('h-5 w-5 shrink-0', color, className)}
    />
  );
}
