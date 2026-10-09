/**
 * Authenticated encryption for secrets stored in the database (AES-256-GCM).
 *
 * The master secret lives only in the backend environment (`AI_KEY_ENCRYPTION_SECRET`).
 * A random 96-bit IV is generated per value and the output is versioned so the scheme
 * can be rotated later: `v1.<iv>.<tag>.<ciphertext>` (all base64url).
 */
import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(masterSecret: string) {
    if (masterSecret.length < 32) throw new SecretBoxError('master secret must contain at least 32 characters');
    // Derive a fixed-size key so any sufficiently long secret works.
    this.#key = createHash('sha256').update(masterSecret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm',this.#key,iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION,iv.toString('base64url'),tag.toString('base64url'),ciphertext.toString('base64url')].join('.');
  }

  /** Throws `SecretBoxError` for tampered, truncated or wrong-secret payloads. */
  decrypt(payload: string): string {
    const [version,iv,tag,ciphertext,...extra] = payload.split('.');
    if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined || extra.length > 0) {
      throw new SecretBoxError('unsupported encrypted payload');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm',this.#key,Buffer.from(iv,'base64url'));
      decipher.setAuthTag(Buffer.from(tag,'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64url')),decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('could not decrypt the stored value');
    }
  }
}
