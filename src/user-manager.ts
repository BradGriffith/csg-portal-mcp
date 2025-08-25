import { MongoClient, Db, Collection } from 'mongodb';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with absolute path
dotenv.config({ path: join(__dirname, '../.env') });

interface UserConfig {
  userHash: string;
  email: string;
  isDefault: boolean;
  createdAt: Date;
  lastUsed: Date;
}

export class UserManager {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<UserConfig> | null = null;

  constructor() {
    // Get MongoDB connection string from environment
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.client = new MongoClient(mongoUri);
  }

  private hashEmail(email: string): string {
    return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
  }

  private async connect(): Promise<void> {
    if (!this.db) {
      await this.client.connect();
      const dbName = process.env.MONGODB_DATABASE || 'csg_portal';
      this.db = this.client.db(dbName);
      this.collection = this.db.collection('users');
      
      // Create index on userHash for efficient lookups
      await this.collection.createIndex({ userHash: 1 }, { unique: true });
      await this.collection.createIndex({ email: 1 }, { unique: true });
    }
  }

  public async addUser(email: string, isDefault: boolean = false): Promise<void> {
    await this.connect();
    
    const userHash = this.hashEmail(email);
    const userConfig: UserConfig = {
      userHash,
      email: email.toLowerCase(),
      isDefault,
      createdAt: new Date(),
      lastUsed: new Date()
    };

    // If this user should be default, remove default from other users first
    if (isDefault) {
      await this.collection!.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    }

    await this.collection!.replaceOne(
      { userHash },
      userConfig,
      { upsert: true }
    );
  }

  public async getDefaultUser(): Promise<string | null> {
    await this.connect();
    
    const defaultUser = await this.collection!.findOne({ isDefault: true });
    if (defaultUser) {
      // Update last used timestamp
      await this.collection!.updateOne(
        { userHash: defaultUser.userHash },
        { $set: { lastUsed: new Date() } }
      );
      return defaultUser.email;
    }
    
    return null;
  }

  public async getMostRecentUser(): Promise<string | null> {
    await this.connect();
    
    const recentUser = await this.collection!.findOne(
      {},
      { sort: { lastUsed: -1 } }
    );
    
    if (recentUser) {
      return recentUser.email;
    }
    
    return null;
  }

  public async getAllUsers(): Promise<{ email: string; isDefault: boolean; lastUsed: Date }[]> {
    await this.connect();
    
    const users = await this.collection!.find({}).sort({ lastUsed: -1 }).toArray();
    return users.map(user => ({
      email: user.email,
      isDefault: user.isDefault,
      lastUsed: user.lastUsed
    }));
  }

  public async setDefaultUser(email: string): Promise<void> {
    await this.connect();
    
    const userHash = this.hashEmail(email);
    
    // Remove default from all users
    await this.collection!.updateMany({}, { $set: { isDefault: false } });
    
    // Set the specified user as default
    const result = await this.collection!.updateOne(
      { userHash },
      { $set: { isDefault: true, lastUsed: new Date() } }
    );
    
    if (result.matchedCount === 0) {
      // User doesn't exist, add them as default
      await this.addUser(email, true);
    }
  }

  public async updateLastUsed(email: string): Promise<void> {
    await this.connect();
    
    const userHash = this.hashEmail(email);
    await this.collection!.updateOne(
      { userHash },
      { $set: { lastUsed: new Date() } }
    );
  }

  public async removeUser(email: string): Promise<void> {
    await this.connect();
    
    const userHash = this.hashEmail(email);
    await this.collection!.deleteOne({ userHash });
  }

  public async hasUsers(): Promise<boolean> {
    await this.connect();
    
    const count = await this.collection!.countDocuments();
    return count > 0;
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }

  // Auto-detect user email from various sources
  public async detectUserEmail(): Promise<string | null> {
    // Try default user first
    let email = await this.getDefaultUser();
    if (email) return email;
    
    // Try most recently used user
    email = await this.getMostRecentUser();
    if (email) return email;
    
    // If no users exist, return null - will need to prompt for initial setup
    return null;
  }
}