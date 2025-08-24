import { MongoClient, Db, Collection } from 'mongodb';
import { createHash } from 'node:crypto';
import { DirectoryEntry, DirectorySearchParams } from './directory.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with absolute path
dotenv.config({ path: join(__dirname, '../.env') });

interface CacheEntry<T> {
  userHash: string;
  searchHash: string;
  data: T;
  timestamp: Date;
  expiresAt: Date;
}

export class MongoSearchCache {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<CacheEntry<DirectoryEntry[]>> | null = null;
  private userEmail: string;
  private userHash: string;

  constructor(userEmail: string) {
    this.userEmail = userEmail;
    this.userHash = this.hashEmail(userEmail);
    
    // Get MongoDB connection string from environment
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.client = new MongoClient(mongoUri);
  }

  private hashEmail(email: string): string {
    return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
  }

  private getCacheKey(params: DirectorySearchParams): string {
    // Create a consistent cache key from search parameters (exclude userEmail and refresh)
    const searchParams = { ...params };
    delete searchParams.userEmail;
    delete searchParams.refresh;
    
    const key = JSON.stringify(searchParams, Object.keys(searchParams).sort());
    return createHash('sha256').update(key).digest('hex');
  }

  private async connect(): Promise<void> {
    if (!this.db) {
      await this.client.connect();
      const dbName = process.env.MONGODB_DATABASE || 'csg_portal';
      this.db = this.client.db(dbName);
      this.collection = this.db.collection('cache');
      
      // Create compound index for efficient lookups and TTL
      await this.collection.createIndex({ userHash: 1, searchHash: 1 }, { unique: true });
      await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index
    }
  }

  public async get(params: DirectorySearchParams): Promise<DirectoryEntry[] | null> {
    await this.connect();
    
    const searchHash = this.getCacheKey(params);
    const document = await this.collection!.findOne({
      userHash: this.userHash,
      searchHash,
      expiresAt: { $gt: new Date() } // Check if not expired
    });
    
    if (!document) {
      return null;
    }

    return document.data;
  }

  public async set(params: DirectorySearchParams, data: DirectoryEntry[], lifetimeHours: number = 24): Promise<void> {
    await this.connect();
    
    const searchHash = this.getCacheKey(params);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (lifetimeHours * 60 * 60 * 1000));

    const cacheEntry: CacheEntry<DirectoryEntry[]> = {
      userHash: this.userHash,
      searchHash,
      data,
      timestamp: now,
      expiresAt
    };

    await this.collection!.replaceOne(
      { userHash: this.userHash, searchHash },
      cacheEntry,
      { upsert: true }
    );
  }

  public async clear(params?: DirectorySearchParams): Promise<void> {
    await this.connect();
    
    if (params) {
      // Clear specific cache entry
      const searchHash = this.getCacheKey(params);
      await this.collection!.deleteOne({
        userHash: this.userHash,
        searchHash
      });
    } else {
      // Clear all cache entries for this user
      await this.collection!.deleteMany({ userHash: this.userHash });
    }
  }

  public async getCacheInfo(params: DirectorySearchParams): Promise<{ exists: boolean; age?: number; expiresIn?: number }> {
    await this.connect();
    
    const searchHash = this.getCacheKey(params);
    const document = await this.collection!.findOne({
      userHash: this.userHash,
      searchHash
    });
    
    if (!document) {
      return { exists: false };
    }

    const now = new Date();
    const age = Math.floor((now.getTime() - document.timestamp.getTime()) / 1000 / 60); // Age in minutes
    const expiresIn = Math.max(0, Math.floor((document.expiresAt.getTime() - now.getTime()) / 1000 / 60)); // Expires in minutes

    return {
      exists: true,
      age,
      expiresIn
    };
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }

  // Static method to get cache stats
  public static async getStats(mongoUri?: string, dbName?: string): Promise<{
    totalEntries: number;
    totalUsers: number;
    avgEntriesPerUser: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  }> {
    const client = new MongoClient(mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017');
    
    try {
      await client.connect();
      const db = client.db(dbName || process.env.MONGODB_DATABASE || 'csg_portal');
      const collection = db.collection('cache');
      
      const totalEntries = await collection.countDocuments();
      const uniqueUsers = await collection.distinct('userHash');
      const totalUsers = uniqueUsers.length;
      const avgEntriesPerUser = totalUsers > 0 ? Math.round(totalEntries / totalUsers) : 0;
      
      const oldestDoc = await collection.findOne({}, { sort: { timestamp: 1 } });
      const newestDoc = await collection.findOne({}, { sort: { timestamp: -1 } });
      
      return {
        totalEntries,
        totalUsers,
        avgEntriesPerUser,
        oldestEntry: oldestDoc?.timestamp || null,
        newestEntry: newestDoc?.timestamp || null
      };
    } finally {
      await client.close();
    }
  }
}