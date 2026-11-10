// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAVE_SETTINGS_ERROR,
  type UserSettingsPatch,
  useUpdateUserSettings,
  useUserSettings,
} from './user-settings-queries';
import {
  createSettingsServer,
  type RenderedSettings,
  renderWithSettingsServer,
  type SettingsServer,
  TEST_USER_SETTINGS,
  waitForCheck,
} from './user-settings-queries.test-harness';

// The app wraps `toast.error` with its defaults, so assert on the wrapped spy.
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError }, Toaster: () => null }));

let save: (patch: UserSettingsPatch) => void;

function Probe() {
  const { data } = useUserSettings();
  const update = useUpdateUserSettings();
  save = update.mutate;
  return (
    <dl>
      <dd id="model">{data?.defaultClaudeModel}</dd>
      <dd id="sound">{String(data?.playSoundOnComplete)}</dd>
      <dd id="saving-model">{String(update.isSaving('defaultClaudeModel'))}</dd>
    </dl>
  );
}

let server: SettingsServer;
let view: RenderedSettings;

const text = (id: string) => view.container.querySelector(`#${id}`)?.textContent;
const held = (path: string) => server.held.filter((request) => request.path === path);
const reads = () => held('userSettings.get');
const saves = () => held('userSettings.update');
const settings = (patch: Partial<typeof TEST_USER_SETTINGS> = {}) => ({
  ...TEST_USER_SETTINGS,
  ...patch,
});

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  server = createSettingsServer({ hold: ['userSettings.get', 'userSettings.update'] });
  view = await renderWithSettingsServer(<Probe />, server);
  await act(async () => reads()[0]?.resolve(settings()));
  await waitForCheck(() => expect(text('model')).toBe('sonnet'));
});

afterEach(async () => {
  await view.unmount();
  vi.unstubAllGlobals();
});

describe('useUpdateUserSettings', () => {
  it('shows a change at once, marks it saving, then commits and refetches', async () => {
    await act(async () => save({ defaultClaudeModel: 'opus' }));
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    expect(text('model')).toBe('opus');
    expect(text('saving-model')).toBe('true');

    await act(async () => saves()[0]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    await waitForCheck(() => expect(reads()).toHaveLength(2));
    expect(text('saving-model')).toBe('false');
    expect(text('model')).toBe('opus');
    await act(async () => reads()[1]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores an older refetch that lands while a newer change is saving', async () => {
    await act(() => {
      void view.queryClient.invalidateQueries();
    });
    await waitForCheck(() => expect(reads()).toHaveLength(2));
    await act(async () => save({ defaultClaudeModel: 'fable' }));
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    await act(async () => reads()[1]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    await waitForCheck(() => expect(text('model')).toBe('fable'));
  });

  it('runs queued changes in order and keeps a newer choice when an older one fails', async () => {
    await act(() => {
      save({ defaultClaudeModel: 'opus' });
      save({ defaultClaudeModel: 'fable' });
      save({ defaultClaudeModel: 'opus' });
    });
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]?.input).toEqual({ defaultClaudeModel: 'opus' });
    expect(text('model')).toBe('opus');

    await act(async () => saves()[0]?.reject('Save rejected'));
    await waitForCheck(() => expect(saves()).toHaveLength(2));
    expect(text('model')).toBe('opus');
    expect(saves()[1]?.input).toEqual({ defaultClaudeModel: 'fable' });

    await act(async () => saves()[1]?.resolve(settings({ defaultClaudeModel: 'fable' })));
    await waitForCheck(() => expect(saves()).toHaveLength(3));
    // Earlier results and refetches wait for the last queued change.
    expect(reads()).toHaveLength(1);
    expect(text('model')).toBe('opus');

    await act(async () => saves()[2]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    await waitForCheck(() => expect(reads()).toHaveLength(2));
    expect(text('model')).toBe('opus');
    expect(toastError).toHaveBeenCalledOnce();
  });

  it('rolls a failed change back to the value before it', async () => {
    await act(() => {
      save({ defaultClaudeModel: 'opus' });
      save({ defaultClaudeModel: 'sonnet' });
    });
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    await act(async () => saves()[0]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    await waitForCheck(() => expect(saves()).toHaveLength(2));
    expect(text('model')).toBe('sonnet');

    await act(async () => saves()[1]?.reject('Save rejected'));
    await waitForCheck(() => expect(text('model')).toBe('opus'));
    expect(text('saving-model')).toBe('false');
    expect(toastError).toHaveBeenCalledWith(
      SAVE_SETTINGS_ERROR,
      expect.objectContaining({ id: SAVE_SETTINGS_ERROR, description: 'Save rejected' })
    );
    await waitForCheck(() => expect(reads()).toHaveLength(2));
  });

  it('restores only the fields a failed change patched', async () => {
    await act(() => {
      save({ playSoundOnComplete: false });
      save({ defaultClaudeModel: 'opus' });
    });
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    expect(text('sound')).toBe('false');

    await act(async () => saves()[0]?.reject('Save rejected'));
    await waitForCheck(() => expect(text('sound')).toBe('true'));
    expect(text('model')).toBe('opus');
    expect(text('saving-model')).toBe('true');
  });

  it('keeps a rolled-back value when a cancelled refetch lands late', async () => {
    await act(async () => save({ defaultClaudeModel: 'opus' }));
    await waitForCheck(() => expect(saves()).toHaveLength(1));
    await act(async () => saves()[0]?.resolve(settings({ defaultClaudeModel: 'opus' })));
    await waitForCheck(() => expect(reads()).toHaveLength(2));

    await act(async () => save({ defaultClaudeModel: 'fable' }));
    await waitForCheck(() => expect(saves()).toHaveLength(2));
    await act(async () => saves()[1]?.reject('Save rejected'));
    await waitForCheck(() => expect(text('model')).toBe('opus'));
    await act(async () => reads()[1]?.resolve(settings()));
    expect(text('model')).toBe('opus');
  });
});
