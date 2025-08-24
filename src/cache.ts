import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'node:crypto';
import { DirectoryEntry, DirectorySearchParams } from './directory.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

export class SearchCache {
  private cacheDir: string;

  constructor(userEmail: string) {
    // Create a hash of the email for directory name
    const userHash = this.hashEmail(userEmail);
    
    // Create user-specific cache directory
    const baseDir = join(homedir(), '.csg-portal-users');
    const userDir = join(baseDir, userHash);
    this.cacheDir = join(userDir, 'cache');
    
    // Create cache directory if it doesn't exist
    this.ensureCacheDirectory();
  }

  private hashEmail(email: string): string {
    // Create a SHA-256 hash of the email for a consistent, filename-safe directory name
    return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
  }

  private ensureCacheDirectory(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { mode: 0o700, recursive: true });
    }
  }

  private getCacheKey(params: DirectorySearchParams): string {
    // Create a consistent cache key from search parameters
    const key = JSON.stringify({
      firstName: params.firstName || '',
      lastName: params.lastName || '',
      city: params.city || '',
      postalCode: params.postalCode || '',
      gradeLevel: params.gradeLevel || ''
    });
    
    // Use a simple hash to create a filename-safe key
    return Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
  }

  private getCacheFilePath(params: DirectorySearchParams): string {
    const key = this.getCacheKey(params);
    return join(this.cacheDir, `directory_${key}.json`);
  }

  public get(params: DirectorySearchParams): DirectoryEntry[] | null {
    const filePath = this.getCacheFilePath(params);
    
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const fileContent = readFileSync(filePath, 'utf8');
      const cacheEntry: CacheEntry<DirectoryEntry[]> = JSON.parse(fileContent);
      
      // Check if cache entry has expired
      if (Date.now() > cacheEntry.expiresAt) {
        return null;
      }

      return cacheEntry.data;
    } catch (error) {
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout
      console.error('Failed to read cache:', error);
      return null;
    }
  }

  public set(params: DirectorySearchParams, data: DirectoryEntry[], lifetimeHours: number = 24): void {
    const filePath = this.getCacheFilePath(params);
    const now = Date.now();
    const expiresAt = now + (lifetimeHours * 60 * 60 * 1000); // Convert hours to milliseconds

    const cacheEntry: CacheEntry<DirectoryEntry[]> = {
      data,
      timestamp: now,
      expiresAt
    };

    try {
      writeFileSync(filePath, JSON.stringify(cacheEntry, null, 2), { mode: 0o600 });
    } catch (error) {
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout
      console.error('Failed to write cache:', error);
    }
  }

  public clear(params?: DirectorySearchParams): void {
    if (params) {
      // Clear specific cache entry
      const filePath = this.getCacheFilePath(params);
      if (existsSync(filePath)) {
        try {
          writeFileSync(filePath, '');
        } catch (error) {
          // Use stderr for logging to avoid corrupting JSON-RPC on stdout
          console.error('Failed to clear cache entry:', error);
        }
      }
    } else {
      // Clear all cache entries (if needed in the future)
      // For now, we'll just implement specific cache clearing
    }
  }

  public getCacheInfo(params: DirectorySearchParams): { exists: boolean; age?: number; expiresIn?: number } {
    const filePath = this.getCacheFilePath(params);
    
    if (!existsSync(filePath)) {
      return { exists: false };
    }

    try {
      const fileContent = readFileSync(filePath, 'utf8');
      const cacheEntry: CacheEntry<DirectoryEntry[]> = JSON.parse(fileContent);
      const now = Date.now();
      
      return {
        exists: true,
        age: Math.floor((now - cacheEntry.timestamp) / 1000 / 60), // Age in minutes
        expiresIn: Math.max(0, Math.floor((cacheEntry.expiresAt - now) / 1000 / 60)) // Expires in minutes
      };
    } catch (error) {
      return { exists: false };
    }
  }
}