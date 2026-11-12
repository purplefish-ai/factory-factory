import type { ReactNode } from 'react';

/** Event definitions are proposed in a workspace and explicitly reviewed before saving. */
export function EventAgentCreate({ children }: { children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-4" aria-label="Create event-triggered automation">
      <h2 className="text-xl font-semibold">Create event-triggered automation</h2>
      <p className="text-sm text-muted-foreground">
        Start a workspace to describe the event and instructions. Your agent will discover available
        sources and prepare a proposal for you to review. Automations are created paused; select one
        here and choose Enable when you're ready. Today only GitHub issue triggers for labeled or
        reopened issues can run; other triggers show why they can't run yet.
      </p>
      {children}
    </section>
  );
}
