import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { CredentialStore, Credentials } from './credentials.js';

export class VeracrossAuth {
  private cookieJar: CookieJar;
  private credentialStore?: CredentialStore;
  private baseUrl: string;
  private isAuthenticated: boolean = false;
  private currentUserEmail?: string;

  constructor(baseUrl: string) {
    this.cookieJar = new CookieJar();
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    // Note: credentialStore will be initialized when user email is provided
  }

  private ensureCredentialStore(userEmail: string): void {
    if (!this.credentialStore || this.currentUserEmail !== userEmail) {
      this.credentialStore = new CredentialStore(userEmail);
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

  public async login(username?: string, password?: string, userEmail?: string): Promise<boolean> {
    try {
      // Determine user email - either provided or extracted from username
      let email: string;
      if (userEmail) {
        email = userEmail;
      } else if (username && username.includes('@')) {
        email = username;
      } else {
        throw new Error('User email is required for authentication');
      }

      // Ensure credential store is set up for this user
      this.ensureCredentialStore(email);

      // Use provided credentials or load from store
      let credentials: Credentials | null = null;
      
      if (username && password) {
        credentials = { username, password };
        await this.credentialStore!.saveCredentials(credentials);
      } else {
        credentials = await this.credentialStore!.loadCredentials();
      }

      if (!credentials) {
        throw new Error('No credentials available');
      }

      // Get login page to extract any CSRF tokens or form data
      const loginPageUrl = `${this.baseUrl}/login`;
      const loginPageResponse = await this.makeRequest(loginPageUrl);
      const loginPageHtml = await loginPageResponse.text();

      // Extract any hidden form fields (CSRF tokens, etc.)
      const hiddenFields = this.extractHiddenFields(loginPageHtml);

      // Perform login
      const loginData = new URLSearchParams({
        username: credentials.username,
        password: credentials.password,
        ...hiddenFields,
      });

      const loginResponse = await this.makeRequest(loginPageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': loginPageUrl,
        },
        body: loginData.toString(),
        redirect: 'manual', // Handle redirects manually to check for success
      });

      // Check if login was successful
      // Typically, successful login redirects to dashboard or returns 302
      if (loginResponse.status === 302 || loginResponse.status === 200) {
        const location = loginResponse.headers.get('location');
        if (location && !location.includes('login')) {
          this.isAuthenticated = true;
          return true;
        }
      }

      // Check response for login error indicators
      const responseText = await loginResponse.text();
      if (!responseText.includes('Invalid') && !responseText.includes('error')) {
        this.isAuthenticated = true;
        return true;
      }

      return false;
    } catch (error) {
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout
      console.error('Login failed:', error);
      return false;
    }
  }

  private extractHiddenFields(html: string): Record<string, string> {
    const hiddenFields: Record<string, string> = {};
    const regex = /<input[^>]*type=["\']hidden["\'][^>]*>/gi;
    const matches = html.match(regex) || [];

    for (const match of matches) {
      const nameMatch = match.match(/name=["\']([^"\']*)["\']/i);
      const valueMatch = match.match(/value=["\']([^"\']*)["\']/i);
      
      if (nameMatch && valueMatch) {
        hiddenFields[nameMatch[1]] = valueMatch[1];
      }
    }

    return hiddenFields;
  }

  public async ensureAuthenticated(userEmail?: string): Promise<boolean> {
    // If no user is set and no email provided, we can't authenticate
    if (!this.currentUserEmail && !userEmail) {
      throw new Error('User email required for authentication');
    }

    // If switching users or not authenticated, try to authenticate
    if (!this.isAuthenticated || (userEmail && userEmail !== this.currentUserEmail)) {
      return await this.login(undefined, undefined, userEmail);
    }

    return true;
  }

  public async makeAuthenticatedRequest(url: string, options: any = {}) {
    await this.ensureAuthenticated();
    return this.makeRequest(url, options);
  }

  public logout(): void {
    this.isAuthenticated = false;
    this.cookieJar = new CookieJar(); // Clear cookies
  }

  public clearStoredCredentials(): void {
    if (this.credentialStore) {
      this.credentialStore.clearCredentials();
    }
    this.logout();
  }
}