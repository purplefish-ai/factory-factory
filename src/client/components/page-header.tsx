import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, children, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-2', className)}>
      <div className="min-w-0">
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 break-words">{description}</p>}
      </div>
      {children && (
        <div className="flex w-full flex-wrap items-center gap-2 md:ml-auto md:w-auto md:justify-end">
          {children}
        </div>
      )}
    </div>
  );
}
