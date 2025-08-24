import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Credentials {
  username: string;
  password: string;
}

export class CredentialStore {
  private userDir: string;
  private credentialsPath: string;
  private keyPath: string;

  constructor(userEmail: string) {
    // Create a hash of the email for directory name
    const userHash = this.hashEmail(userEmail);
    
    // Create user-specific directory structure
    const baseDir = join(homedir(), '.csg-portal-users');
    this.userDir = join(baseDir, userHash);
    this.credentialsPath = join(this.userDir, 'credentials');
    this.keyPath = join(this.userDir, 'key');
    
    // Ensure user directory exists with proper permissions
    this.ensureUserDirectory();
  }

  private hashEmail(email: string): string {
    // Create a SHA-256 hash of the email for a consistent, filename-safe directory name
    return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
  }

  private ensureUserDirectory(): void {
    const baseDir = join(homedir(), '.csg-portal-users');
    
    // Create base directory if it doesn't exist
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { mode: 0o700, recursive: true });
    }
    
    // Create user-specific directory if it doesn't exist
    if (!existsSync(this.userDir)) {
      mkdirSync(this.userDir, { mode: 0o700, recursive: true });
    }
  }

  private async getOrCreateEncryptionKey(): Promise<Buffer> {
    if (existsSync(this.keyPath)) {
      return readFileSync(this.keyPath);
    }
    
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  private async encrypt(text: string): Promise<string> {
    const key = await this.getOrCreateEncryptionKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }

  private async decrypt(encryptedText: string): Promise<string> {
    const key = await this.getOrCreateEncryptionKey();
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  public async saveCredentials(credentials: Credentials): Promise<void> {
    const encrypted = await this.encrypt(JSON.stringify(credentials));
    writeFileSync(this.credentialsPath, encrypted, { mode: 0o600 });
  }

  public async loadCredentials(): Promise<Credentials | null> {
    if (!existsSync(this.credentialsPath)) {
      return null;
    }

    try {
      const encrypted = readFileSync(this.credentialsPath, 'utf8');
      const decrypted = await this.decrypt(encrypted);
      return JSON.parse(decrypted) as Credentials;
    } catch (error) {
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout  
      console.error('Failed to load credentials:', error);
      return null;
    }
  }

  public hasCredentials(): boolean {
    return existsSync(this.credentialsPath);
  }

  public clearCredentials(): void {
    if (existsSync(this.credentialsPath)) {
      writeFileSync(this.credentialsPath, '');
    }
  }
}