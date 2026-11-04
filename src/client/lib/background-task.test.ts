import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { runInBackground } from './background-task';

describe('background client tasks', () => {
  it('reports rejected work through a contextual error toast', async () => {
    const before = toast.getHistory().length;
    runInBackground(Promise.reject(new Error('Network unavailable')), "Couldn't refresh data");
    await Promise.resolve();
    expect(toast.getHistory().slice(before)).toMatchObject([
      { type: 'error', title: "Couldn't refresh data", description: 'Network unavailable' },
    ]);
  });

  it('updates one toast when the same background action fails repeatedly', async () => {
    const title = 'Background refresh retry failed';
    runInBackground(Promise.reject(new Error('First failure')), title);
    runInBackground(Promise.reject(new Error('Latest failure')), title);
    await vi.waitFor(() => {
      const matching = toast.getHistory().filter((item) => 'title' in item && item.title === title);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ description: 'Latest failure' });
    });
  });

  it('accepts explicitly normalized synchronous navigation without reporting an error', async () => {
    const before = toast.getHistory().length;
    runInBackground(Promise.resolve(undefined), "Couldn't open workspace list");
    await Promise.resolve();
    expect(toast.getHistory()).toHaveLength(before);
  });

  it('does not report an error for successful background work', async () => {
    const before = toast.getHistory().length;
    runInBackground(Promise.resolve(), "Couldn't refresh data");
    await Promise.resolve();
    expect(toast.getHistory()).toHaveLength(before);
  });
});
