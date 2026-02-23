import { cn } from '@/lib/utils';

interface LogoIconProps {
  className?: string;
}

export function LogoIcon({ className }: LogoIconProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8', className)}
    >
      <rect width="512" height="512" rx="96" fill="#0A0A0A" />
      <text
        x="70"
        y="320"
        fontFamily="'IBM Plex Mono', monospace"
        fontWeight="600"
        fontSize="120"
        fill="#FFE500"
      >
        $
      </text>
      <text
        x="175"
        y="320"
        fontFamily="'IBM Plex Mono', monospace"
        fontWeight="600"
        fontSize="120"
        fill="#FAFAFA"
      >
        ff
      </text>
      <rect x="355" y="225" width="60" height="105" fill="#FAFAFA" />
    </svg>
  );
}

interface LogoTextProps {
  className?: string;
}

export function LogoText({ className }: LogoTextProps) {
  return (
    <span
      className={cn('tracking-tight uppercase', className)}
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <span className="font-black text-foreground">Factory</span>
      <span className="font-black ml-1 text-foreground/35 dark:text-brand">Factory</span>
    </span>
  );
}

interface LogoProps {
  showText?: boolean;
  showIcon?: boolean;
  iconClassName?: string;
  textClassName?: string;
  className?: string;
}

export function Logo({
  showText = true,
  showIcon = true,
  iconClassName,
  textClassName,
  className,
}: LogoProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {showIcon && <LogoIcon className={iconClassName} />}
      {showText && <LogoText className={textClassName} />}
    </div>
  );
}
