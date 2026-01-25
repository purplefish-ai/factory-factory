'use client';

/**
 * User message component
 */

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="p-4 bg-primary/10 rounded-lg ml-8">
      <div className="text-xs text-muted-foreground mb-2 font-medium">You</div>
      <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{text}</div>
    </div>
  );
}
