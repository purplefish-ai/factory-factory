import { cn } from '@/lib/utils';
import type { WorkspaceMailKind, WorkspaceMailSummary } from '@/shared/workspace-mail';

const kindLabels: Record<WorkspaceMailKind, string> = {
  MESSAGE: 'Message',
  PROGRESS: 'Progress',
  BLOCKER: 'Blocker',
  QUESTION: 'Question',
  COMPLETION: 'Completion',
  INSTRUCTION: 'Instruction',
};

export function MailMetadata({ mail }: { mail: WorkspaceMailSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className={cn(mail.kind === 'BLOCKER' && 'text-destructive')}>
        {kindLabels[mail.kind]}
      </span>
      <span className="break-words">
        {mail.sourceWorkspaceName} · {mail.sourceProjectName}
      </span>
      <time dateTime={mail.createdAt.toISOString()} title={mail.createdAt.toLocaleString()}>
        {mail.createdAt.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}
      </time>
    </div>
  );
}
