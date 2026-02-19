import { FileCheck, MessageCircleQuestion, ShieldAlert } from 'lucide-react';

interface WorkspaceStatusIconProps {
  pendingRequestType?: 'permission_request' | 'plan_approval' | 'user_question' | null;
  isWorking?: boolean;
}

export function WorkspaceStatusIcon({ pendingRequestType, isWorking }: WorkspaceStatusIconProps) {
  if (pendingRequestType) {
    switch (pendingRequestType) {
      case 'permission_request':
        return <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-orange-500" />;
      case 'plan_approval':
        return <FileCheck className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
      case 'user_question':
        return <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
    }
  }

  if (isWorking) {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-brand animate-pulse" />;
  }

  return <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/30" />;
}
