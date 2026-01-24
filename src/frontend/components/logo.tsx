import { cn } from '@/lib/utils';

interface LogoIconProps {
  className?: string;
}

export function LogoIcon({ className }: LogoIconProps) {
  return (
    <svg
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8', className)}
    >
      {/* Outer square: 80x80 at (0, 0) */}
      <rect
        x="0"
        y="0"
        width="80"
        height="80"
        stroke="currentColor"
        strokeWidth="6"
        fill="none"
        rx="2"
      />
      {/* Inner square: 60x60 at (10, 10) - concentric */}
      <rect
        x="10"
        y="10"
        width="60"
        height="60"
        stroke="currentColor"
        strokeWidth="6"
        fill="none"
        rx="2"
      />
    </svg>
  );
}

interface LogoTextProps {
  className?: string;
}

export function LogoText({ className }: LogoTextProps) {
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
