import logoUrl from '@/client/assets/logo.svg';
import { cn } from '@/lib/utils';
import './logo.css';

interface LogoIconProps {
  className?: string;
  decorative?: boolean;
}

export function LogoIcon({ className, decorative = false }: LogoIconProps) {
  return (
    <img
      src={logoUrl}
      alt={decorative ? '' : 'Factory Factory'}
      width={512}
      height={512}
      className={cn('size-8', className)}
    />
  );
}

interface LogoTextProps {
  className?: string;
}

export function LogoText({ className }: LogoTextProps) {
  return (
    <span className={cn('factory-wordmark text-base text-foreground', className)}>
      <span>Factory</span> <span>Factory</span>
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
      {showIcon && <LogoIcon className={iconClassName} decorative={showText} />}
      {showText && <LogoText className={textClassName} />}
    </div>
  );
}
