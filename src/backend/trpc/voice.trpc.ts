/**
 * Voice Mode tRPC Router
 *
 * Admin configuration for BYOK Deepgram voice mode: an enabled toggle and an
 * encrypted API key, following the same encrypt-on-write pattern as the
 * Linear integration's API key (see linear.trpc.ts / crypto.service.ts).
 */

import { z } from 'zod';
import type { ApplicationServices } from '@/backend/app-context';
import {
  DEEPGRAM_TTS_SPEED_MAX,
  DEEPGRAM_TTS_SPEED_MIN,
  isKnownDeepgramVoiceModel,
} from '@/shared/deepgram-voices';
import { publicProcedure, router, trustedLocalProcedure } from './trpc';

const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';

/** Default grant token lifetime: long enough to cover a voice-mode session's
 * initial STT connection without a mid-session refresh, short enough to
 * limit exposure if it leaks (e.g. via devtools network tab). */
const GRANT_TOKEN_TTL_SECONDS = 600;

/** Bounds outbound Deepgram calls so a stalled connection fails fast with a
 * usable error instead of hanging until the runtime's network timeout. */
const DEEPGRAM_FETCH_TIMEOUT_MS = 10_000;

function getDecryptedApiKey(
  cryptoService: ApplicationServices['cryptoService'],
  settings: { deepgramApiKeyEncrypted: string | null }
): string | null {
  if (!settings.deepgramApiKeyEncrypted) {
    return null;
  }
  return cryptoService.decrypt(settings.deepgramApiKeyEncrypted);
}

/**
 * Deepgram's error responses share a consistent {err_code, err_msg} shape.
 * Two auth failures are common enough configuring voice mode to call out
 * with a specific fix rather than surfacing an opaque HTTP status:
 *  - 401 INVALID_AUTH: the key itself is wrong, mistyped, or revoked.
 *  - 403 INSUFFICIENT_PERMISSIONS: a real key, but /v1/auth/grant needs
 *    Member scope or higher than the key actually has.
 * Returns null when the error doesn't match either, so callers fall back
 * to their own generic message.
 */
function friendlyDeepgramAuthError(status: number, detail: string): string | null {
  let errCode: unknown;
  try {
    errCode = JSON.parse(detail)?.err_code;
  } catch {
    return null;
  }

  if (status === 401 && errCode === 'INVALID_AUTH') {
    return (
      'Deepgram rejected this API key as invalid. Double-check you copied the full key ' +
      'from the Deepgram console with no extra spaces or missing characters, and that it ' +
      "hasn't been deleted or regenerated there since it was saved."
    );
  }
  if (status === 400 && errCode === 'BAD_REQUEST') {
    return (
      'Deepgram rejected this request as malformed. If you recently copied the key ' +
      'from the console it may include a stray newline or extra space; re-copy and save ' +
      'it again in Voice Mode settings.'
    );
  }
  if (status === 403 && errCode === 'INSUFFICIENT_PERMISSIONS') {
    return (
      "This Deepgram API key doesn't have permission to start voice sessions. " +
      'Create a new key in the Deepgram console with the "Member" role ' +
      '(API Keys → Create Key → Advanced → Member) and save it in Voice Mode settings.'
    );
  }
  return null;
}

/**
 * Exercises the same /v1/auth/grant call mintGrantToken makes (discarding
 * the returned token) rather than the more permissive /v1/projects — a key
 * that passes a plain project-listing check can still lack the Member/
 * `usage::write` scope grant issuance requires, which would otherwise defer
 * the real failure until the user actually tries to start a voice session.
 */
async function validateDeepgramApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch(DEEPGRAM_GRANT_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: GRANT_TOKEN_TTL_SECONDS }),
      signal: AbortSignal.timeout(DEEPGRAM_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      return { valid: true };
    }
    const detail = await response.text().catch(() => '');
    return {
      valid: false,
      error:
        friendlyDeepgramAuthError(response.status, detail) ??
        `Deepgram returned ${response.status}`,
    };
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
      ttsModel: settings.voiceTtsModel,
      ttsSpeed: settings.voiceTtsSpeed,
    };
  }),

  /** Validate a Deepgram API key before it's saved. */
  validateApiKey: trustedLocalProcedure
    // .trim() first: copy-pasted keys routinely carry a trailing newline or
    // leading/trailing space, which Deepgram rejects with a misleading
    // "Invalid credentials" 400 rather than an obvious whitespace complaint.
    .input(z.object({ apiKey: z.string().trim().min(1) }))
    .mutation(({ input }) => {
      return validateDeepgramApiKey(input.apiKey);
    }),

  /**
   * Update voice mode config. `apiKey` is only encrypted and persisted when
   * provided; omitting it leaves the currently stored key untouched, mirroring
   * the Linear config form's "blank means don't change" behavior. `ttsModel`
   * and `ttsSpeed` are likewise only touched when provided, so the voice
   * settings form can save independently of the enabled toggle or key.
   */
  updateConfig: trustedLocalProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        apiKey: z.string().trim().min(1).optional(),
        ttsModel: z
          .string()
          .min(1)
          .refine(isKnownDeepgramVoiceModel, 'Unknown Deepgram voice model')
          .optional(),
        ttsSpeed: z.number().min(DEEPGRAM_TTS_SPEED_MIN).max(DEEPGRAM_TTS_SPEED_MAX).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { cryptoService, userSettingsQueryService } = ctx.appContext.services;
      await userSettingsQueryService.update({
        voiceModeEnabled: input.enabled,
        deepgramApiKeyEncrypted: input.apiKey ? cryptoService.encrypt(input.apiKey) : undefined,
        voiceTtsModel: input.ttsModel,
        voiceTtsSpeed: input.ttsSpeed,
      });
      const settings = await userSettingsQueryService.get();
      return {
        enabled: settings.voiceModeEnabled,
        hasApiKey: Boolean(settings.deepgramApiKeyEncrypted),
        ttsModel: settings.voiceTtsModel,
        ttsSpeed: settings.voiceTtsSpeed,
      };
    }),

  /**
   * Mint a short-lived Deepgram grant token so the browser can connect
   * directly to Deepgram's streaming STT without ever seeing the long-lived key.
   */
  mintGrantToken: trustedLocalProcedure.mutation(async ({ ctx }) => {
    const { cryptoService, userSettingsQueryService } = ctx.appContext.services;
    const settings = await userSettingsQueryService.get();
    if (!settings.voiceModeEnabled) {
      throw new Error('Voice mode is disabled');
    }
    const apiKey = getDecryptedApiKey(cryptoService, settings);
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
      signal: AbortSignal.timeout(DEEPGRAM_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const friendly = friendlyDeepgramAuthError(response.status, detail);
      throw new Error(
        friendly ??
          `Failed to mint Deepgram grant token: ${response.status}${detail ? ` — ${detail}` : ''}`
      );
    }

    const body = (await response.json()) as { access_token?: unknown; expires_in?: number };
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('Deepgram grant response did not include an access token');
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds: body.expires_in ?? GRANT_TOKEN_TTL_SECONDS,
    };
  }),
});
