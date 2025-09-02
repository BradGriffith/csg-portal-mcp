import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { BrowserAuthServer } from './browser-auth.js';
import { MongoCredentialStore } from './mongodb-credentials.js';

export class VeracrossAuth {
  private cookieJar: CookieJar;
  private baseUrl: string;
  private isAuthenticated: boolean = false;
  private currentUserEmail?: string;
  private browserAuthServer?: BrowserAuthServer;
  private credentialStore?: MongoCredentialStore;

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

  private ensureCredentialStore(userEmail: string): void {
    if (!this.credentialStore || this.currentUserEmail !== userEmail) {
      this.credentialStore = new MongoCredentialStore(userEmail);
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
   * Trigger browser authentication when credentials are invalid/missing
   */
  public async authenticateWithBrowser(userEmail: string): Promise<boolean> {
    try {
      // First check if we have valid stored session cookies
      const hasSession = await this.hasStoredSession(userEmail);
      if (hasSession) {
        await this.loadStoredSession(userEmail);
        // Test the session
        try {
          const testResponse = await this.makeRequest(`${this.baseUrl}/parent`);
          if (testResponse.ok && !testResponse.url.includes('login')) {
            this.isAuthenticated = true;
            return true;
          }
        } catch (error) {
          // Session is invalid, continue to browser auth
        }
      }
      
      // Initialize browser auth server to handle the authentication flow
      this.ensureBrowserAuthServer(userEmail);
      
      // Start the browser authentication process
      const authResult = await this.browserAuthServer!.startAuthFlow();
      
      if (authResult) {
        this.isAuthenticated = true;
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.error('Authentication failed:', error);
      return false;
    }
  }

  /**
   * Attempt login using stored username and password
   */
  private async attemptPasswordLogin(userEmail: string, password: string): Promise<boolean> {
    try {
      
      // Use the two-step login process
      let cookieJar: any[] = [];
      
      // Step 1: Get password page directly with username in URL
      const encodedUsername = encodeURIComponent(userEmail);
      const passwordPageUrl = `${this.baseUrl}/login/password?username=${encodedUsername}`;
      
      const passwordPageResponse = await this.makeRequest(passwordPageUrl);
      if (!passwordPageResponse.ok) {
        throw new Error(`Password page request failed: ${passwordPageResponse.status}`);
      }

      const passwordPageHtml = await passwordPageResponse.text();
      
      // Step 2: Extract hidden form fields
      const hiddenFields: any = {};
      const hiddenInputRegex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
      const matches = passwordPageHtml.match(hiddenInputRegex) || [];
      
      for (const match of matches) {
        const nameMatch = match.match(/name=["']([^"']+)["']/);
        const valueMatch = match.match(/value=["']([^"']*)["']/);
        if (nameMatch && valueMatch) {
          hiddenFields[nameMatch[1]] = valueMatch[1];
        }
      }

      // Step 3: Submit password to the password endpoint
      const loginData = new URLSearchParams({
        username: userEmail,
        password: password,
        ...hiddenFields,
      });

      const loginResponse = await this.makeRequest(`${this.baseUrl}/login/password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': passwordPageUrl,
        },
        body: loginData.toString(),
        redirect: 'manual',
      });

      // Step 4: Check if login was successful (redirect indicates success)
      if (loginResponse.status >= 300 && loginResponse.status < 400) {
        const redirectUrl = loginResponse.headers.get('location');
        if (redirectUrl) {
          // Follow redirect to complete login
          const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${this.baseUrl}${redirectUrl}`;
          const redirectResponse = await this.makeRequest(fullRedirectUrl, { redirect: 'manual' });
          
          if (redirectResponse.ok) {
            // Store successful session
            const cookieString = await this.cookieJar.getCookieString(this.baseUrl);
            const sessionData = {
              userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              timestamp: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
              cookies: cookieString
            };

            this.ensureCredentialStore(userEmail);
            await this.credentialStore!.saveCredentials({
              username: userEmail,
              password: JSON.stringify(sessionData)
            });

            this.isAuthenticated = true;
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      console.error('Password login error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Load a stored session for the user
   */
  private async loadStoredSession(userEmail: string): Promise<boolean> {
    try {
      this.ensureCredentialStore(userEmail);
      
      const credentials = await this.credentialStore!.loadCredentials();
      if (credentials && credentials.password) {
        try {
          // Try to parse as session data (JSON)
          const sessionData = JSON.parse(credentials.password);
          if (sessionData.cookies) {
            // Load cookies into jar
            const cookieString = sessionData.cookies;
            const cookies = cookieString.split(';').map((c: string) => c.trim());
            for (const cookie of cookies) {
              if (cookie) {
                await this.cookieJar.setCookie(cookie, this.baseUrl);
              }
            }
            this.isAuthenticated = true;
            return true;
          }
        } catch {
          // Not JSON session data, might be raw password - not supported without browser
        }
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
      }
    }

    // Session is invalid or missing - check for stored password credentials
    this.ensureCredentialStore(userEmail);
    const credentials = await this.credentialStore!.loadCredentials();
    
    if (credentials && credentials.password) {
      try {
        // Check if stored data is session data (JSON) or actual password
        JSON.parse(credentials.password);
        // It's session data but expired/invalid - need fresh authentication
      } catch {
        // It's a raw password - attempt automatic login
        return await this.attemptPasswordLogin(userEmail, credentials.password);
      }
    }

    // No valid credentials - trigger browser authentication
    return await this.authenticateWithBrowser(userEmail);
  }

  public async makeAuthenticatedRequest(url: string, options: any = {}) {
    // Ensure we have a valid session (but don't start browser flow here)
    if (!this.currentUserEmail) {
      throw new Error('No user email set. Please authenticate first.');
    }
    
    // For cross-domain requests (portals.veracross.com vs accounts.veracross.com),
    // use stored session cookies directly instead of the cookie jar
    const urlHost = new URL(url).hostname;
    const baseUrlHost = new URL(this.baseUrl).hostname;
    
    if (urlHost !== baseUrlHost) {
      
      // Get stored session cookies directly
      this.ensureCredentialStore(this.currentUserEmail);
      const credentials = await this.credentialStore!.loadCredentials();
      
      if (!credentials || !credentials.password) {
        throw new Error('No stored credentials found for cross-domain request');
      }
      
      let sessionData;
      try {
        sessionData = JSON.parse(credentials.password);
      } catch {
        throw new Error('Invalid session data for cross-domain request');
      }
      
      if (!sessionData.cookies) {
        throw new Error('No session cookies found for cross-domain request');
      }
      
      // Make direct request with stored cookies
      return fetch(url, {
        ...options,
        headers: {
          'Cookie': sessionData.cookies,
          'User-Agent': sessionData.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...options.headers,
        },
      });
    }
    
    // Same-domain request - use normal cookie jar approach
    await this.ensureAuthenticated(this.currentUserEmail);
    return this.makeRequest(url, options);
  }

  public logout(): void {
    this.isAuthenticated = false;
    this.cookieJar = new CookieJar(); // Clear cookies
  }

  public async clearStoredCredentials(): Promise<void> {
    if (this.credentialStore) {
      await this.credentialStore.clearCredentials();
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
      this.ensureCredentialStore(userEmail);
      const credentials = await this.credentialStore!.loadCredentials();
      if (credentials && credentials.password) {
        try {
          const sessionData = JSON.parse(credentials.password);
          return sessionData.cookies ? true : false;
        } catch {
          // Not session data
          return false;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}