import { MongoClient, Db, Collection } from 'mongodb';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with absolute path
dotenv.config({ path: join(__dirname, '../.env') });

export interface Credentials {
  username: string;
  password: string;
}

interface EncryptedCredentialDocument {
  userHash: string;
  encryptedCredentials: string;
  iv: string;
  createdAt: Date;
  updatedAt: Date;
}

export class MongoCredentialStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<EncryptedCredentialDocument> | null = null;
  private userEmail: string;
  private userHash: string;
  private encryptionKey: Buffer;

  constructor(userEmail: string) {
    this.userEmail = userEmail;
    this.userHash = this.hashEmail(userEmail);
    
    // Get MongoDB connection string from environment
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.client = new MongoClient(mongoUri);
    
    // Derive encryption key from environment variable and user email
    const masterKey = process.env.ENCRYPTION_MASTER_KEY || 'default-key-change-in-production';
    this.encryptionKey = this.deriveKey(masterKey, userEmail);
  }

  private hashEmail(email: string): string {
    return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
  }

  private deriveKey(masterKey: string, userEmail: string): Buffer {
    // Create a user-specific encryption key from master key and email
    const combined = masterKey + userEmail;
    return createHash('sha256').update(combined).digest();
  }

  private async connect(): Promise<void> {
    if (!this.db) {
      await this.client.connect();
      const dbName = process.env.MONGODB_DATABASE || 'csg_portal';
      this.db = this.client.db(dbName);
      this.collection = this.db.collection('credentials');
      
      // Create index on userHash for efficient lookups
      await this.collection.createIndex({ userHash: 1 }, { unique: true });
    }
  }

  private encrypt(text: string): { encrypted: string; iv: string } {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex')
    };
  }

  private decrypt(encryptedText: string, ivHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  public async saveCredentials(credentials: Credentials): Promise<void> {
    await this.connect();
    
    const credentialsJson = JSON.stringify(credentials);
    const { encrypted, iv } = this.encrypt(credentialsJson);
    
    const document: EncryptedCredentialDocument = {
      userHash: this.userHash,
      encryptedCredentials: encrypted,
      iv,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.collection!.replaceOne(
      { userHash: this.userHash },
      document,
      { upsert: true }
    );
  }

  public async loadCredentials(): Promise<Credentials | null> {
    await this.connect();
    
    const document = await this.collection!.findOne({ userHash: this.userHash });
    
    if (!document) {
      return null;
    }

    try {
      const decrypted = this.decrypt(document.encryptedCredentials, document.iv);
      return JSON.parse(decrypted) as Credentials;
    } catch (error) {
      console.error('Failed to decrypt credentials for user:', this.userEmail, error);
      return null;
    }
  }

  public async hasCredentials(): Promise<boolean> {
    await this.connect();
    const count = await this.collection!.countDocuments({ userHash: this.userHash });
    return count > 0;
  }

  public async clearCredentials(): Promise<void> {
    await this.connect();
    await this.collection!.deleteOne({ userHash: this.userHash });
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }

  // Static method to get stats (useful for monitoring)
  public static async getStats(mongoUri?: string, dbName?: string): Promise<{ totalUsers: number; lastUpdated: Date | null }> {
    const client = new MongoClient(mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017');
    
    try {
      await client.connect();
      const db = client.db(dbName || process.env.MONGODB_DATABASE || 'csg_portal');
      const collection = db.collection('credentials');
      
      const totalUsers = await collection.countDocuments();
      const lastDoc = await collection.findOne({}, { sort: { updatedAt: -1 } });
      
      return {
        totalUsers,
        lastUpdated: lastDoc?.updatedAt || null
      };
    } finally {
      await client.close();
    }
  }
}