import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetBaseDir = vi.hoisted(() => vi.fn());
const mockInfo = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('./config.service', () => ({
  configService: {
    getBaseDir: (...args: unknown[]) => mockGetBaseDir(...args),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockInfo(...args),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

import { cryptoService } from './crypto.service';

describe('cryptoService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBaseDir.mockReturnValue('/tmp/factory-factory-test');
    (cryptoService as unknown as { encryptionKey: Buffer | null }).encryptionKey = null;
  });

  it('generates a key when missing and round-trips encrypted values', () => {
    mockExistsSync.mockImplementation((path: string) => path === '/tmp/factory-factory-test');

    const encrypted = cryptoService.encrypt('super-secret');
    const decrypted = cryptoService.decrypt(encrypted);

    expect(decrypted).toBe('super-secret');
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/factory-factory-test/encryption.key',
      expect.any(Buffer),
      { mode: 0o600 }
    );
    expect(mockInfo).toHaveBeenCalledWith('Generating new encryption key', {
      path: '/tmp/factory-factory-test/encryption.key',
    });
  });

  it('reuses an existing valid key and does not write a new one', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.alloc(32, 7));

    const encrypted = cryptoService.encrypt('hello');
    expect(cryptoService.decrypt(encrypted)).toBe('hello');

    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/factory-factory-test/encryption.key');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('throws when existing key has an invalid length', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.alloc(31, 1));

    expect(() => cryptoService.encrypt('hello')).toThrow('has invalid length');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('throws when decrypt input format is invalid', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.alloc(32, 9));

    expect(() => cryptoService.decrypt('bad-format')).toThrow(
      'Invalid encrypted value format: expected iv:authTag:ciphertext'
    );
  });
});
