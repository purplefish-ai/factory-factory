/**
 * Voice Mode tRPC Router
 *
 * Admin configuration for BYOK Deepgram voice mode: an enabled toggle and an
 * encrypted API key, following the same encrypt-on-write pattern as the
 * Linear integration's API key (see linear.trpc.ts / crypto.service.ts).
 */

import { z } from 'zod';
import type { ApplicationServices } from '@/backend/app-context';
import { publicProcedure, router } from './trpc';

const DEEPGRAM_PROJECTS_URL = 'https://api.deepgram.com/v1/projects';
const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';

/** Default grant token lifetime: long enough to cover a voice-mode session's
 * initial STT connection without a mid-session refresh, short enough to
 * limit exposure if it leaks (e.g. via devtools network tab). */
const GRANT_TOKEN_TTL_SECONDS = 600;

async function getDecryptedApiKey(
  cryptoService: ApplicationServices['cryptoService'],
  userSettingsQueryService: ApplicationServices['userSettingsQueryService']
): Promise<string | null> {
  const settings = await userSettingsQueryService.get();
  if (!settings.deepgramApiKeyEncrypted) {
    return null;
  }
  return cryptoService.decrypt(settings.deepgramApiKeyEncrypted);
}

async function validateDeepgramApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch(DEEPGRAM_PROJECTS_URL, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (response.ok) {
      return { valid: true };
    }
    return { valid: false, error: `Deepgram returned ${response.status}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Request failed' };
  }
}

export const voiceRouter = router({
  /** Current voice mode config. Never returns the plaintext/encrypted key. */
  getConfig: publicProcedure.query(async ({ ctx }) => {
    const settings = await ctx.appContext.services.userSettingsQueryService.get();
    return {
      enabled: settings.voiceModeEnabled,
      hasApiKey: Boolean(settings.deepgramApiKeyEncrypted),
    };
  }),

  /** Validate a Deepgram API key before it's saved. */
  validateApiKey: publicProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(({ input }) => {
      return validateDeepgramApiKey(input.apiKey);
    }),

  /**
   * Update voice mode config. `apiKey` is only encrypted and persisted when
   * provided; omitting it leaves the currently stored key untouched, mirroring
   * the Linear config form's "blank means don't change" behavior.
   */
  updateConfig: publicProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        apiKey: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { cryptoService, userSettingsQueryService } = ctx.appContext.services;
      await userSettingsQueryService.update({
        voiceModeEnabled: input.enabled,
        deepgramApiKeyEncrypted: input.apiKey ? cryptoService.encrypt(input.apiKey) : undefined,
      });
      const settings = await userSettingsQueryService.get();
      return {
        enabled: settings.voiceModeEnabled,
        hasApiKey: Boolean(settings.deepgramApiKeyEncrypted),
      };
    }),

  /**
   * Mint a short-lived Deepgram grant token so the browser can connect
   * directly to Deepgram's streaming STT without ever seeing the long-lived key.
   */
  mintGrantToken: publicProcedure.mutation(async ({ ctx }) => {
    const { cryptoService, userSettingsQueryService } = ctx.appContext.services;
    const apiKey = await getDecryptedApiKey(cryptoService, userSettingsQueryService);
    if (!apiKey) {
      throw new Error('Voice mode is not configured with a Deepgram API key');
    }

    const response = await fetch(DEEPGRAM_GRANT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: GRANT_TOKEN_TTL_SECONDS }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Failed to mint Deepgram grant token: ${response.status}${detail ? ` — ${detail}` : ''}`
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: body.access_token,
      expiresInSeconds: body.expires_in ?? GRANT_TOKEN_TTL_SECONDS,
    };
  }),
});
