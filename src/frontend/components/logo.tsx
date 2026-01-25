import { cn } from '@/lib/utils';

interface LogoIconProps {
  className?: string;
}

function LogoIcon({ className }: LogoIconProps) {
  return (
    <svg
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8', className)}
    >
      {/* Outer square: 74x74 inset by 3 so stroke fits in viewBox */}
      <rect x="3" y="3" width="74" height="74" stroke="currentColor" strokeWidth="6" fill="none" />
      {/* Inner square: 37x37 centered (half size of outer) */}
      <rect
        x="21.5"
        y="21.5"
        width="37"
        height="37"
        stroke="currentColor"
        strokeWidth="6"
        fill="none"
      />
    </svg>
  );
}

interface LogoTextProps {
  className?: string;
}

function LogoText({ className }: LogoTextProps) {
  return (
    <span className={cn('tracking-tight uppercase', className)}>
      <span className="font-light">Factory</span>
      <span className="font-bold ml-1">Factory</span>
    </span>
  );
}

interface LogoProps {
  showText?: boolean;
  iconClassName?: string;
  textClassName?: string;
  className?: string;
}

export function Logo({ showText = true, iconClassName, textClassName, className }: LogoProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <LogoIcon className={iconClassName} />
      {showText && <LogoText className={textClassName} />}
    </div>
  );
}
