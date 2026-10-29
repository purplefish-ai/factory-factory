/** Hide the old scheduled-session default without rewriting stored or custom names. */
export function getSessionDisplayName(
  session: { name?: string | null; workflow?: string | null },
  fallback: string
): string {
  if (session.workflow === 'periodic-task' && session.name === 'Periodic task') {
    return 'Agent';
  }
  return session.name || fallback;
}
