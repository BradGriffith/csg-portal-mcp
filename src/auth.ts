import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { BrowserAuthServer } from './browser-auth.js';

export class VeracrossAuth {
  private cookieJar: CookieJar;
  private baseUrl: string;
  private isAuthenticated: boolean = false;
  private currentUserEmail?: string;
  private browserAuthServer?: BrowserAuthServer;

  constructor(baseUrl: string) {
    this.cookieJar = new CookieJar();
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  private ensureBrowserAuthServer(userEmail: string): void {
    if (!this.browserAuthServer || this.currentUserEmail !== userEmail) {
      this.browserAuthServer = new BrowserAuthServer(userEmail);
      this.currentUserEmail = userEmail;
      // Reset authentication state when switching users
      this.isAuthenticated = false;
    }
  }

  private async makeRequest(url: string, options: any = {}) {
    const cookies = await this.cookieJar.getCookieString(url);
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Cookie': cookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        ...options.headers,
      },
    });

    // Store cookies from response
    const setCookieHeaders = response.headers.raw()['set-cookie'];
    if (setCookieHeaders) {
      for (const cookie of setCookieHeaders) {
        await this.cookieJar.setCookie(cookie, url);
      }
    }

    return response;
  }

  /**
   * Start browser-based authentication flow
   */
  public async authenticateWithBrowser(userEmail: string): Promise<boolean> {
    try {
      this.ensureBrowserAuthServer(userEmail);
      
      // Start the browser authentication flow
      const success = await this.browserAuthServer!.startAuthFlow();
      
      if (success) {
        // Load the stored session into our cookie jar
        await this.loadStoredSession(userEmail);
        this.isAuthenticated = true;
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Browser authentication failed:', error);
      return false;
    }
  }

  /**
   * Load a stored browser session for the user
   */
  private async loadStoredSession(userEmail: string): Promise<boolean> {
    try {
      this.ensureBrowserAuthServer(userEmail);
      
      const cookieJar = await this.browserAuthServer!.createCookieJar();
      if (cookieJar) {
        this.cookieJar = cookieJar;
        this.isAuthenticated = true;
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to load stored session:', error);
      return false;
    }
  }

  /**
   * Ensure user is authenticated, attempting to use stored session first
   */
  public async ensureAuthenticated(userEmail: string): Promise<boolean> {
    // If we're already authenticated for this user, we're good
    if (this.isAuthenticated && this.currentUserEmail === userEmail) {
      return true;
    }

    // Try to load stored session first
    const sessionLoaded = await this.loadStoredSession(userEmail);
    if (sessionLoaded) {
      // Test the session by making a simple request
      try {
        const testResponse = await this.makeRequest(`${this.baseUrl}/parent`);
        if (testResponse.ok && !testResponse.url.includes('login')) {
          return true;
        }
      } catch (error) {
        // Session might be invalid, continue to browser auth
      }
    }

    // If no stored session or it's invalid, user needs to authenticate via browser
    throw new Error('Browser authentication required. Please use the authenticate_browser tool first.');
  }

  public async makeAuthenticatedRequest(url: string, options: any = {}) {
    // Ensure we have a valid session (but don't start browser flow here)
    if (!this.currentUserEmail) {
      throw new Error('No user email set. Please authenticate first.');
    }
    
    await this.ensureAuthenticated(this.currentUserEmail);
    return this.makeRequest(url, options);
  }

  public logout(): void {
    this.isAuthenticated = false;
    this.cookieJar = new CookieJar(); // Clear cookies
  }

  public async clearStoredCredentials(): Promise<void> {
    if (this.browserAuthServer) {
      // Clear the stored session data
      const credStore = new (await import('./mongodb-credentials.js')).MongoCredentialStore(this.currentUserEmail!);
      await credStore.clearCredentials();
    }
    this.logout();
  }

  public async close(): Promise<void> {
    if (this.browserAuthServer) {
      this.browserAuthServer.close();
    }
  }

  /**
   * Check if user has a stored session
   */
  public async hasStoredSession(userEmail: string): Promise<boolean> {
    try {
      this.ensureBrowserAuthServer(userEmail);
      const sessionData = await this.browserAuthServer!.getStoredSession();
      return sessionData !== null;
    } catch (error) {
      return false;
    }
  }
}