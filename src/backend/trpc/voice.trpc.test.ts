import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCryptoService = vi.hoisted(() => ({
  encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, '')),
}));

const mockUserSettingsQueryService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

import { voiceRouter } from './voice.trpc';

function createCaller() {
  return voiceRouter.createCaller({
    appContext: {
      services: {
        cryptoService: mockCryptoService,
        userSettingsQueryService: mockUserSettingsQueryService,
      },
    },
  } as never);
}

describe('voiceRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getConfig', () => {
    it('never returns the stored key, only enabled and hasApiKey', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
        voiceTtsModel: 'aura-2-thalia-en',
        voiceTtsSpeed: 1,
      });

      const result = await createCaller().getConfig();

      expect(result).toEqual(expect.objectContaining({ enabled: true, hasApiKey: true }));
      expect(JSON.stringify(result)).not.toContain('dg_secret');
    });

    it('reports hasApiKey false when no key is stored', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: false,
        deepgramApiKeyEncrypted: null,
        voiceTtsModel: 'aura-2-thalia-en',
        voiceTtsSpeed: 1,
      });

      const result = await createCaller().getConfig();

      expect(result).toEqual(expect.objectContaining({ enabled: false, hasApiKey: false }));
    });

    it('also returns the configured TTS model and speed', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
        voiceTtsModel: 'aura-2-apollo-en',
        voiceTtsSpeed: 1.3,
      });

      const result = await createCaller().getConfig();

      expect(result).toEqual(
        expect.objectContaining({ ttsModel: 'aura-2-apollo-en', ttsSpeed: 1.3 })
      );
    });
  });

  describe('validateApiKey', () => {
    it('returns valid when Deepgram accepts the key', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const result = await createCaller().validateApiKey({ apiKey: 'dg_test' });

      expect(result).toEqual({ valid: true });
      // Exercises the same grant-issuance call mintGrantToken makes, not the
      // more permissive /v1/projects — a key can list projects but still
      // lack the scope /v1/auth/grant requires.
      expect(fetch).toHaveBeenCalledWith(
        'https://api.deepgram.com/v1/auth/grant',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Token dg_test' }),
        })
      );
    });

    it('returns invalid with the raw status when the failure is unrecognized', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(''),
      } as Response);

      const result = await createCaller().validateApiKey({ apiKey: 'bad_key' });

      expect(result).toEqual({ valid: false, error: 'Deepgram returned 500' });
    });

    it('returns a friendly, actionable error for a 401 INVALID_AUTH response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}'),
      } as Response);

      const result = await createCaller().validateApiKey({ apiKey: 'bad_key' });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/invalid/i);
      expect(result.error).toMatch(/console/i);
    });

    it('returns a friendly, actionable error for a 403 INSUFFICIENT_PERMISSIONS response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            '{"err_code":"INSUFFICIENT_PERMISSIONS","err_msg":"Insufficient permissions"}'
          ),
      } as Response);

      const result = await createCaller().validateApiKey({ apiKey: 'scoped_key' });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Member.*role/);
    });

    it('returns invalid when the request throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network down'));

      const result = await createCaller().validateApiKey({ apiKey: 'dg_test' });

      expect(result).toEqual({ valid: false, error: 'network down' });
    });

    it('trims whitespace from a copy-pasted key before sending it to Deepgram', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await createCaller().validateApiKey({ apiKey: '  dg_test\n' });

      expect(fetch).toHaveBeenCalledWith(
        'https://api.deepgram.com/v1/auth/grant',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Token dg_test' }),
        })
      );
    });
  });

  describe('updateConfig', () => {
    it('encrypts and persists a newly provided key', async () => {
      mockUserSettingsQueryService.update.mockResolvedValue(undefined);
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_new',
      });

      const result = await createCaller().updateConfig({ enabled: true, apiKey: 'dg_new' });

      expect(mockCryptoService.encrypt).toHaveBeenCalledWith('dg_new');
      expect(mockUserSettingsQueryService.update).toHaveBeenCalledWith({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_new',
      });
      expect(result).toEqual({ enabled: true, hasApiKey: true });
    });

    it('leaves the stored key untouched when no apiKey is provided', async () => {
      mockUserSettingsQueryService.update.mockResolvedValue(undefined);
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: false,
        deepgramApiKeyEncrypted: 'encrypted:dg_existing',
      });

      await createCaller().updateConfig({ enabled: false });

      expect(mockCryptoService.encrypt).not.toHaveBeenCalled();
      expect(mockUserSettingsQueryService.update).toHaveBeenCalledWith({
        voiceModeEnabled: false,
        deepgramApiKeyEncrypted: undefined,
      });
    });

    it('trims whitespace from a copy-pasted key before encrypting it', async () => {
      mockUserSettingsQueryService.update.mockResolvedValue(undefined);
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_new',
      });

      await createCaller().updateConfig({ enabled: true, apiKey: '  dg_new\n' });

      expect(mockCryptoService.encrypt).toHaveBeenCalledWith('dg_new');
    });

    it('persists and returns ttsModel and ttsSpeed when provided', async () => {
      mockUserSettingsQueryService.update.mockResolvedValue(undefined);
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_existing',
        voiceTtsModel: 'aura-2-luna-en',
        voiceTtsSpeed: 1.2,
      });

      const result = await createCaller().updateConfig({
        enabled: true,
        ttsModel: 'aura-2-luna-en',
        ttsSpeed: 1.2,
      });

      expect(mockUserSettingsQueryService.update).toHaveBeenCalledWith({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: undefined,
        voiceTtsModel: 'aura-2-luna-en',
        voiceTtsSpeed: 1.2,
      });
      expect(result).toEqual(
        expect.objectContaining({ ttsModel: 'aura-2-luna-en', ttsSpeed: 1.2 })
      );
    });
  });

  describe('mintGrantToken', () => {
    it('throws when voice mode is disabled, even if a key is configured', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: false,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });

      await expect(createCaller().mintGrantToken()).rejects.toThrow('Voice mode is disabled');
      expect(fetch).not.toHaveBeenCalled();
      expect(mockCryptoService.decrypt).not.toHaveBeenCalled();
    });

    it('throws when no key is configured', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: null,
      });

      await expect(createCaller().mintGrantToken()).rejects.toThrow(
        'Voice mode is not configured with a Deepgram API key'
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('decrypts the stored key and returns the minted grant token', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'jwt-token', expires_in: 600 }),
      } as Response);

      const result = await createCaller().mintGrantToken();

      expect(mockCryptoService.decrypt).toHaveBeenCalledWith('encrypted:dg_secret');
      expect(fetch).toHaveBeenCalledWith(
        'https://api.deepgram.com/v1/auth/grant',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Token dg_secret' }),
        })
      );
      expect(result).toEqual({ accessToken: 'jwt-token', expiresInSeconds: 600 });
    });

    it("throws with Deepgram's raw error detail for an unrecognized failure", async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"err_msg":"Internal error"}'),
      } as Response);

      await expect(createCaller().mintGrantToken()).rejects.toThrow(
        'Failed to mint Deepgram grant token: 500 — {"err_msg":"Internal error"}'
      );
    });

    it('throws a friendly, actionable message for a 403 INSUFFICIENT_PERMISSIONS response', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            '{"err_code":"INSUFFICIENT_PERMISSIONS","err_msg":"Insufficient permissions"}'
          ),
      } as Response);

      await expect(createCaller().mintGrantToken()).rejects.toThrow(/Member.*role/);
    });

    it('throws a friendly, actionable message for a 401 INVALID_AUTH response', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}'),
      } as Response);

      const rejection = createCaller().mintGrantToken();
      await expect(rejection).rejects.toThrow(/invalid/i);
      await expect(rejection).rejects.toThrow(/console/i);
    });

    it('throws a friendly, actionable message for a 400 BAD_REQUEST response (malformed/whitespace-padded key)', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"err_code":"BAD_REQUEST","err_msg":"Invalid credentials."}'),
      } as Response);

      const rejection = createCaller().mintGrantToken();
      await expect(rejection).rejects.toThrow(/whitespace|newline/i);
      await expect(rejection).rejects.toThrow(/re-copy/i);
    });
  });
});
