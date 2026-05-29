import { describe, expect, it } from 'vitest';
import { ConfigEnvSchema } from './env-schemas';

describe('ConfigEnvSchema', () => {
  it('treats blank optional string environment values as unset', () => {
    const parsed = ConfigEnvSchema.parse({
      DEFAULT_MODEL: '   ',
      NOTIFICATION_SOUND_FILE: '   ',
      CORS_ALLOWED_ORIGINS: '   ',
      BASE_DIR: '   ',
      WORKTREE_BASE_DIR: '   ',
      REPOS_DIR: '   ',
      WS_LOGS_PATH: '   ',
      FRONTEND_STATIC_PATH: '   ',
      DATABASE_PATH: '   ',
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        DEFAULT_MODEL: undefined,
        NOTIFICATION_SOUND_FILE: undefined,
        CORS_ALLOWED_ORIGINS: undefined,
        BASE_DIR: undefined,
        WORKTREE_BASE_DIR: undefined,
        REPOS_DIR: undefined,
        WS_LOGS_PATH: undefined,
        FRONTEND_STATIC_PATH: undefined,
        DATABASE_PATH: undefined,
      })
    );
  });
});
