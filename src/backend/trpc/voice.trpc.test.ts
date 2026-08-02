import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('getConfig', () => {
    it('never returns the stored key, only enabled and hasApiKey', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });

      const result = await createCaller().getConfig();

      expect(result).toEqual({ enabled: true, hasApiKey: true });
      expect(JSON.stringify(result)).not.toContain('dg_secret');
    });

    it('reports hasApiKey false when no key is stored', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
        voiceModeEnabled: false,
        deepgramApiKeyEncrypted: null,
      });

      const result = await createCaller().getConfig();

      expect(result).toEqual({ enabled: false, hasApiKey: false });
    });
  });

  describe('validateApiKey', () => {
    it('returns valid when Deepgram accepts the key', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const result = await createCaller().validateApiKey({ apiKey: 'dg_test' });

      expect(result).toEqual({ valid: true });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.deepgram.com/v1/projects',
        expect.objectContaining({ headers: { Authorization: 'Token dg_test' } })
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

    it('returns invalid when the request throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network down'));

      const result = await createCaller().validateApiKey({ apiKey: 'dg_test' });

      expect(result).toEqual({ valid: false, error: 'network down' });
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
  });

  describe('mintGrantToken', () => {
    it('throws when no key is configured', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({ deepgramApiKeyEncrypted: null });

      await expect(createCaller().mintGrantToken()).rejects.toThrow(
        'Voice mode is not configured with a Deepgram API key'
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('decrypts the stored key and returns the minted grant token', async () => {
      mockUserSettingsQueryService.get.mockResolvedValue({
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
        deepgramApiKeyEncrypted: 'encrypted:dg_secret',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}'),
      } as Response);

      await expect(createCaller().mintGrantToken()).rejects.toThrow(/invalid/i);
      await expect(createCaller().mintGrantToken()).rejects.toThrow(/console/i);
    });
  });
});
