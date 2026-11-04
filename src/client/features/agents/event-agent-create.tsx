import type { ReactNode } from 'react';

/** Event definitions are proposed in a workspace and explicitly reviewed before saving. */
export function EventAgentCreate({ children }: { children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-4" aria-label="Create event agent">
      <h2 className="text-xl font-semibold">Create event agent</h2>
      <p className="text-sm text-muted-foreground">
        Start a workspace to describe the event and instructions. Your agent will discover available
        sources and prepare a proposal for you to review before creating a paused definition.
        Listening and automatic event runs are not yet available.
      </p>
      {children}
    </section>
  );
}
