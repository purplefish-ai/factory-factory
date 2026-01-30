/**
 * Shared utilities for todo/task progress calculation
 */

/**
 * Helper to calculate todo progress statistics
 */
export function calculateTodoProgress(todos: { status: string }[]): {
  completedCount: number;
  totalCount: number;
  progressPercent: number;
} {
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return {
    completedCount,
    totalCount,
    progressPercent,
  };
}
