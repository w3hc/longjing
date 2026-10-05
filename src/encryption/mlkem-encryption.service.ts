import { Injectable, Logger } from '@nestjs/common';
import { TeeKeyManagerService } from '../attestation/tee-key-manager.service';
import * as crypto from 'crypto';

/**
 * ML-KEM (Kyber) quantum-resistant encryption service
 *
 * This service provides ML-KEM encryption/decryption using ML-KEM-1024 (NIST FIPS 203).
 * Keys are managed by TeeKeyManagerService for enhanced security.
 *
 * Architecture (Multi-Recipient):
 * 1. Client generates random AES-256 key
 * 2. Client encrypts data with AES-256-GCM
 * 3. For each recipient (client + server):
 *    - Encapsulate shared secret with recipient's ML-KEM public key
 *    - XOR-encrypt the AES key with the shared secret
 *    - Store { publicKey, ciphertext (KEM + encrypted AES key) }
 * 4. Client sends { recipients[], encryptedData, iv, authTag }
 * 5. Server finds its recipient entry (by public key)
 * 6. Server decapsulates to recover shared secret
 * 7. Server XOR-decrypts to recover AES key
 * 8. Server decrypts data with AES-256-GCM
 *
 * Compatible with w3pk's mlkemEncrypt/mlkemDecrypt functions.
 */

export interface RecipientEntry {
  publicKey: string; // Base64 ML-KEM-1024 public key (1568 bytes)
  ciphertext: string; // Base64 combined: ML-KEM ciphertext (1568) + encrypted AES key (32) = 1600 bytes
}

export interface MultiRecipientEncryptedPayload {
  recipients: RecipientEntry[]; // Array of recipients
  encryptedData: string; // Base64 AES-256-GCM encrypted data (shared)
  iv: string; // Base64 IV (12 bytes)
  authTag: string; // Base64 auth tag (16 bytes)
}

// Legacy single-recipient format (kept for backward compatibility)
export interface EncryptedPayload {
  ciphertext: string; // ML-KEM ciphertext (base64)
  encryptedData: string; // AES-256-GCM encrypted data (base64)
  iv: string; // Initialization vector (base64)
  authTag: string; // GCM authentication tag (base64)
}

@Injectable()
export class MlKemEncryptionService {
  private readonly logger = new Logger(MlKemEncryptionService.name);

  constructor(private readonly keyManager: TeeKeyManagerService) {}

  /**
   * Get the admin's public key for client-side encryption
   */
  getPublicKey(): string | null {
    return this.keyManager.getPublicKey();
  }

  /**
   * Check if encryption is available
   */
  isAvailable(): boolean {
    return this.keyManager.isAvailable();
  }

  /**
   * Decrypt a multi-recipient encrypted payload
   *
   * @param payload - Multi-recipient encrypted payload from client (w3pk format)
   * @returns Decrypted plaintext
   */
  decryptMultiRecipient(payload: MultiRecipientEncryptedPayload): string {
    const publicKey = this.keyManager.getPublicKeyBytes();

    if (!this.keyManager.isAvailable() || !publicKey) {
      throw new Error('ML-KEM encryption not initialized');
    }

    try {
      // Find the recipient entry for this server's public key
      const serverPublicKeyBase64 = Buffer.from(publicKey).toString('base64');
      const recipientEntry = payload.recipients.find(
        (r) => r.publicKey === serverPublicKeyBase64,
      );

      if (!recipientEntry) {
        throw new Error(
          `Server public key not found in recipients list (expected: ${serverPublicKeyBase64.substring(0, 32)}...)`,
        );
      }

      // Decode combined ciphertext (ML-KEM ciphertext + encrypted AES key)
      const combinedCiphertext = Buffer.from(
        recipientEntry.ciphertext,
        'base64',
      );

      // Split: ML-KEM ciphertext (1568 bytes) + encrypted AES key (32 bytes)
      const kemCiphertextLength = 1568;
      if (combinedCiphertext.length !== kemCiphertextLength + 32) {
        throw new Error(
          `Invalid combined ciphertext size: ${combinedCiphertext.length} (expected ${kemCiphertextLength + 32})`,
        );
      }

      const kemCiphertext = combinedCiphertext.subarray(0, kemCiphertextLength);
      const encryptedAesKey = combinedCiphertext.subarray(kemCiphertextLength);

      // Decapsulate to recover shared secret
      const sharedSecret = this.keyManager.decapsulate(kemCiphertext);

      // XOR-decrypt the AES key using the first 32 bytes of shared secret
      const kek = sharedSecret.subarray(0, 32);
      const aesKey = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        aesKey[i] = encryptedAesKey[i] ^ kek[i];
      }

      // Decode encrypted data components
      const encryptedData = Buffer.from(payload.encryptedData, 'base64');
      const iv = Buffer.from(payload.iv, 'base64');
      const authTag = Buffer.from(payload.authTag, 'base64');

      // Decrypt data with AES-256-GCM
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedData);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf-8');
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error('Multi-recipient decryption failed:', error);
      }
      // In test mode, preserve original error message for better debugging
      if (process.env.NODE_ENV === 'test') {
        throw error;
      }
      throw new Error('Failed to decrypt multi-recipient data', {
        cause: error,
      });
    }
  }

  /**
   * Decrypt an encrypted payload (legacy single-recipient format)
   *
   * @param payload - Encrypted payload from client
   * @returns Decrypted plaintext
   * @deprecated Use decryptMultiRecipient for new implementations
   */
  decrypt(payload: EncryptedPayload): string {
    if (!this.keyManager.isAvailable()) {
      throw new Error('ML-KEM encryption not initialized');
    }

    try {
      // Decode from base64
      const ciphertext = Buffer.from(payload.ciphertext, 'base64');
      const encryptedData = Buffer.from(payload.encryptedData, 'base64');
      const iv = Buffer.from(payload.iv, 'base64');
      const authTag = Buffer.from(payload.authTag, 'base64');

      // Validate sizes
      if (ciphertext.length !== 1568) {
        throw new Error(
          `Invalid ML-KEM ciphertext size: ${ciphertext.length} (expected 1568)`,
        );
      }

      // Decapsulate to recover shared secret
      const sharedSecret = this.keyManager.decapsulate(ciphertext);

      // Decrypt data with AES-256-GCM
      const decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedData);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf-8');
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error('Decryption failed:', error);
      }
      // In test mode, preserve original error message for better debugging
      if (process.env.NODE_ENV === 'test') {
        throw error;
      }
      throw new Error('Failed to decrypt data', { cause: error });
    }
  }

  /**
   * Encrypt data (for testing purposes)
   * In production, encryption should happen on the client side
   */
  encrypt(plaintext: string): EncryptedPayload {
    const mlkem = this.keyManager.getMlKem();
    const publicKey = this.keyManager.getPublicKeyBytes();

    if (!mlkem || !publicKey) {
      throw new Error('ML-KEM encryption not initialized');
    }

    try {
      // Encapsulate with public key to generate shared secret
      const [ciphertext, sharedSecret] = mlkem.encap(publicKey);

      // Generate random IV
      const iv = crypto.randomBytes(12); // 96-bit IV for GCM

      // Encrypt data with AES-256-GCM
      const cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
      let encrypted = cipher.update(plaintext, 'utf-8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        ciphertext: Buffer.from(ciphertext).toString('base64'),
        encryptedData: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      };
    } catch (error) {
      this.logger.error('Encryption failed:', error);
      throw new Error('Failed to encrypt data', { cause: error });
    }
  }
}
