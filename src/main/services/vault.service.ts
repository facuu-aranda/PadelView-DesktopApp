import { safeStorage } from 'electron';
import Store from 'electron-store';

interface VaultSchema {
  secrets: Record<string, string>; // Hex-encoded encrypted values
}

class VaultService {
  private store: Store<VaultSchema>;

  constructor() {
    const StoreClass = (typeof Store === 'function' ? Store : (Store as any).default) as typeof Store;
    this.store = new StoreClass({
      name: 'padelview-vault',
      defaults: {
        secrets: {}
      }
    });
  }

  /**
   * Set a sensitive configuration value securely encrypted.
   */
  public setSecret(key: string, value: string): void {
    if (!value) {
      this.deleteSecret(key);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback to plain text if safeStorage is not available (e.g. testing environments without desktop session)
      console.warn('safeStorage is not available. Saving in plain text!');
      const secrets = this.store.get('secrets') || {};
      secrets[key] = Buffer.from(value, 'utf-8').toString('base64');
      this.store.set('secrets', secrets);
      return;
    }

    try {
      const encryptedBuffer = safeStorage.encryptString(value);
      const encryptedHex = encryptedBuffer.toString('hex');
      
      const secrets = this.store.get('secrets') || {};
      secrets[key] = encryptedHex;
      this.store.set('secrets', secrets);
    } catch (error) {
      console.error(`Failed to encrypt secret for key: ${key}`, error);
      throw new Error(`Encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get a decrypted sensitive configuration value.
   */
  public getSecret(key: string): string | null {
    const secrets = this.store.get('secrets') || {};
    const encryptedHex = secrets[key];

    if (!encryptedHex) {
      return null;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('safeStorage is not available. Reading plain text (Base64)!');
      return Buffer.from(encryptedHex, 'base64').toString('utf-8');
    }

    try {
      const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
      return safeStorage.decryptString(encryptedBuffer);
    } catch (error) {
      // If safeStorage was previously unavailable and we stored as Base64, or encryption key changed:
      try {
        const decoded = Buffer.from(encryptedHex, 'hex').toString('utf-8');
        return decoded;
      } catch {
        console.error(`Failed to decrypt secret for key: ${key}`, error);
        return null;
      }
    }
  }

  /**
   * Delete a secret key from the vault.
   */
  public deleteSecret(key: string): void {
    const secrets = this.store.get('secrets') || {};
    if (secrets[key]) {
      delete secrets[key];
      this.store.set('secrets', secrets);
    }
  }

  /**
   * Clear all secrets.
   */
  public clearAll(): void {
    this.store.set('secrets', {});
  }
}

export const vaultService = new VaultService();
