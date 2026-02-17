/**
 * Crypto Service
 *
 * AES-256-GCM encryption/decryption for secrets stored at rest (e.g., API keys).
 * The encryption key is auto-generated and stored at {baseDir}/encryption.key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configService } from './config.service';
import { createLogger } from './logger.service';

const logger = createLogger('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits

class CryptoService {
  private encryptionKey: Buffer | null = null;

  private getKeyPath(): string {
    return join(configService.getBaseDir(), 'encryption.key');
  }

  private loadOrCreateKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyPath = this.getKeyPath();

    if (existsSync(keyPath)) {
      this.encryptionKey = readFileSync(keyPath);
      if (this.encryptionKey.length !== KEY_LENGTH) {
        throw new Error(
          `Encryption key at ${keyPath} has invalid length: ${this.encryptionKey.length} (expected ${KEY_LENGTH})`
        );
      }
      return this.encryptionKey;
    }

    // Auto-generate a new key
    logger.info('Generating new encryption key', { path: keyPath });
    const key = randomBytes(KEY_LENGTH);
    const dir = dirname(keyPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(keyPath, key, { mode: 0o600 });
    this.encryptionKey = key;
    return key;
  }

  /**
   * Encrypt a plaintext string.
   * Returns a string in the format: iv:authTag:ciphertext (all base64-encoded).
   */
  encrypt(plaintext: string): string {
    const key = this.loadOrCreateKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  /**
   * Decrypt a string previously encrypted with encrypt().
   * Expects format: iv:authTag:ciphertext (all base64-encoded).
   */
  decrypt(encrypted: string): string {
    const key = this.loadOrCreateKey();
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format: expected iv:authTag:ciphertext');
    }

    const iv = Buffer.from(parts[0] as string, 'base64');
    const authTag = Buffer.from(parts[1] as string, 'base64');
    const ciphertext = Buffer.from(parts[2] as string, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  }
}

export const cryptoService = new CryptoService();
