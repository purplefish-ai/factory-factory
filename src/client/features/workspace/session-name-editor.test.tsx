// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent, within } from 'storybook/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionNameEditor } from './session-name-editor';

const mocks = vi.hoisted(() => ({ save: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ session: { listSessions: { invalidate: mocks.invalidate } } }),
    session: { updateSession: { useMutation: () => ({ mutateAsync: mocks.save }) } },
  },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.save.mockReset().mockResolvedValue({});
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function renderEditor() {
  const onDone = vi.fn();
  await act(() =>
    root.render(<SessionNameEditor sessionId="s1" workspaceId="w1" name="Chat 1" onDone={onDone} />)
  );
  return { input: within(container).getByRole('textbox', { name: 'Chat name' }), onDone };
}
it('saves a trimmed name and refreshes the workspace sessions', async () => {
  const { input, onDone } = await renderEditor();
  await act(async () => {
    await userEvent.clear(input);
    await userEvent.type(input, '  Review API  {Enter}');
  });
  expect(mocks.save).toHaveBeenCalledWith({ id: 's1', name: 'Review API' });
  expect(mocks.invalidate).toHaveBeenCalledWith({ workspaceId: 'w1' });
  expect(onDone).toHaveBeenCalledOnce();
});
it('cancels with Escape without saving', async () => {
  const { input, onDone } = await renderEditor();
  await act(async () => userEvent.type(input, ' draft{Escape}'));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledOnce();
});
it('keeps the draft and error visible after a failed save', async () => {
  mocks.save.mockRejectedValue(new Error('Offline'));
  const { input, onDone } = await renderEditor();
  await act(async () => {
    await userEvent.clear(input);
    await userEvent.type(input, 'Review{Enter}');
  });
  expect(within(container).getByRole('alert').textContent).toContain("Couldn't rename chat.");
  expect((input as HTMLInputElement).value).toBe('Review');
  expect(onDone).not.toHaveBeenCalled();
});
