import express from 'express';
import { Server } from 'http';
import getPort from 'get-port';
import open from 'open';
import fetch from 'node-fetch';
import { MongoCredentialStore } from './mongodb-credentials.js';
import { CookieJar } from 'tough-cookie';

interface SessionData {
  cookies: string;
  userAgent: string;
  timestamp: Date;
  expiresAt: Date;
}

export class BrowserAuthServer {
  private app: express.Express;
  private server: Server | null = null;
  private credentialStore: MongoCredentialStore;
  private userEmail: string;
  private authPromise: Promise<boolean> | null = null;
  private authResolve: ((value: boolean) => void) | null = null;

  constructor(userEmail: string) {
    this.userEmail = userEmail;
    this.credentialStore = new MongoCredentialStore(userEmail);
    this.app = express();
    this.setupMiddleware();
  }

  private setupMiddleware() {
    // Parse cookies and other headers
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Handle login form submission
    this.app.post('/login', async (req, res) => {
      try {
        await this.handleLoginSubmission(req, res);
      } catch (error) {
        console.error('Login submission error:', error);
        res.status(500).json({
          success: false,
          message: 'Internal server error during login'
        });
      }
    });
    
    // Set up callback route
    this.app.get('/callback', async (req, res) => {
      try {
        await this.handleCallback(req, res);
      } catch (error) {
        console.error('Callback error:', error);
        res.status(500).send('Authentication failed. Please try again.');
        if (this.authResolve) {
          this.authResolve(false);
        }
      }
    });

    // Health check route
    this.app.get('/health', (req, res) => {
      res.send('Auth server is running');
    });

    // Auto-redirect detection endpoint
    this.app.get('/redirect-check', (req, res) => {
      const callbackUrl = `${req.protocol}://${req.get('host')}/callback`;
      const cookieHeader = req.headers.cookie;
      
      // If we have Veracross cookies, redirect to callback
      if (cookieHeader && this.isValidVeracrossSession(cookieHeader)) {
        res.redirect(callbackUrl);
      } else {
        res.json({ 
          status: 'waiting', 
          message: 'Still waiting for Veracross login',
          callbackUrl 
        });
      }
    });

    // Serve login form page
    this.app.get('/', (req, res) => {
      const callbackUrl = `${req.protocol}://${req.get('host')}/callback`;
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CSG Portal - Secure Login</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
            }
            .login-container { 
              background: white; border-radius: 15px; padding: 40px; max-width: 400px; width: 100%;
              box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            }
            .header { text-align: center; margin-bottom: 30px; }
            .header h1 { color: #1f2937; margin: 0 0 10px 0; font-size: 24px; }
            .header p { color: #6b7280; margin: 0; font-size: 14px; }
            .form-group { margin-bottom: 20px; }
            .form-group label { 
              display: block; margin-bottom: 8px; color: #374151; font-weight: 500; font-size: 14px;
            }
            .form-group input { 
              width: 100%; padding: 12px 16px; border: 2px solid #e5e7eb; border-radius: 8px;
              font-size: 16px; transition: border-color 0.2s; box-sizing: border-box;
            }
            .form-group input:focus { 
              outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
            }
            .login-btn { 
              width: 100%; background: #3b82f6; color: white; border: none; padding: 14px;
              border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;
              transition: background-color 0.2s; margin-top: 10px;
            }
            .login-btn:hover { background: #2563eb; }
            .login-btn:disabled { background: #9ca3af; cursor: not-allowed; }
            .security-note { 
              background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px;
              padding: 15px; margin-top: 20px; font-size: 13px; color: #0c4a6e;
            }
            .loading { display: none; text-align: center; padding: 20px; }
            .success { display: none; text-align: center; padding: 20px; color: #059669; }
            .error { display: none; color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; 
                     border-radius: 6px; padding: 12px; margin: 15px 0; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="login-container">
            <div class="header">
              <h1>🏫 CSG Portal Login</h1>
              <p>Enter your Veracross credentials to authenticate securely</p>
            </div>
            
            <form id="loginForm" onsubmit="handleLogin(event)">
              <div class="form-group">
                <label for="username">Email/Username</label>
                <input type="email" id="username" name="username" required 
                       placeholder="your@email.com" autocomplete="username">
              </div>
              
              <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required 
                       placeholder="Your Veracross password" autocomplete="current-password">
              </div>
              
              <button type="submit" class="login-btn">
                🔐 Login to Veracross
              </button>
            </form>
            
            <div id="loading" class="loading">
              <p>🔄 Logging in to Veracross...</p>
              <p style="font-size: 14px; color: #6b7280;">This may take a few seconds</p>
            </div>
            
            <div id="success" class="success">
              <h3>✅ Login Successful!</h3>
              <p>Your session has been captured and stored securely.</p>
            </div>
            
            <div id="error" class="error"></div>
            
            <div class="security-note">
              <strong>🔒 Security:</strong> Your credentials are encrypted and stored securely for authentication with Veracross. 
              Session cookies are captured after successful login for ongoing API access.
            </div>
          </div>
          
          <script>
            async function handleLogin(event) {
              event.preventDefault();
              
              const form = document.getElementById('loginForm');
              const loading = document.getElementById('loading');
              const success = document.getElementById('success');
              const error = document.getElementById('error');
              const submitBtn = form.querySelector('button[type="submit"]');
              
              // Hide previous states
              error.style.display = 'none';
              success.style.display = 'none';
              
              // Show loading
              form.style.display = 'none';
              loading.style.display = 'block';
              
              const formData = new FormData(form);
              const credentials = {
                username: formData.get('username'),
                password: formData.get('password')
              };
              
              try {
                // Submit login to our server, which will handle Veracross authentication
                const response = await fetch('/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(credentials)
                });
                
                const result = await response.json();
                
                if (result.success) {
                  // Success! Show success message and auto-close
                  loading.style.display = 'none';
                  success.style.display = 'block';
                  
                  // Auto-close window after 2 seconds (shorter delay)
                  setTimeout(() => {
                    // Try multiple methods to close the window
                    if (window.opener) {
                      window.opener.focus();
                    }
                    window.close();
                    
                    // If window.close() doesn't work, redirect to a closing page
                    setTimeout(() => {
                      window.location.href = 'about:blank';
                    }, 500);
                  }, 2000);
                  
                } else {
                  throw new Error(result.message || 'Login failed');
                }
                
              } catch (err) {
                // Show error and restore form
                loading.style.display = 'none';
                form.style.display = 'block';
                error.style.display = 'block';
                error.textContent = '❌ Login failed: ' + (err.message || 'Please check your credentials and try again.');
                
                // Clear password field for security
                document.getElementById('password').value = '';
              }
            }
          </script>
        </body>
        </html>
      `);
    });
  }

  private async handleCallback(req: express.Request, res: express.Response) {
    // Get all cookies from the request
    const cookieHeader = req.headers.cookie;
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (compatible; CSG-Portal-MCP)';
    const referer = req.headers.referer || '';

    // Check if this looks like a redirect from Veracross
    const fromVeracross = referer.includes('veracross.com') || referer.includes('portals.veracross.com');

    if (!cookieHeader) {
      // If no cookies but came from Veracross, they might need to complete login
      if (fromVeracross) {
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Complete Veracross Login</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .retry-btn { background: #007cba; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; }
            </style>
          </head>
          <body>
            <h2>🔄 Complete Your Veracross Login</h2>
            <p>It looks like you were redirected from Veracross, but no session was found.</p>
            <p>This usually means you need to complete the login process.</p>
            <a href="https://portals.veracross.com/csg/parent" class="retry-btn">🔓 Complete Login to Veracross</a>
            <p style="margin-top: 20px;"><small>After logging in successfully, you should be automatically redirected back here.</small></p>
          </body>
          </html>
        `);
      } else {
        // First visit - show instructions
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Authentication Needed</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .login-btn { background: #007cba; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; }
            </style>
          </head>
          <body>
            <h2>🔐 Veracross Login Required</h2>
            <p>Please log into Veracross first to capture your session.</p>
            <a href="https://portals.veracross.com/csg/login?return=${encodeURIComponent(req.url)}" class="login-btn">🚀 Login to Veracross</a>
            <p style="margin-top: 20px;"><small>You'll be automatically redirected back here after successful login.</small></p>
          </body>
          </html>
        `);
      }
      return;
    }

    // Check if the cookies contain a valid Veracross session
    if (!this.isValidVeracrossSession(cookieHeader)) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invalid Session</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .retry-btn { background: #dc3545; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; }
          </style>
        </head>
        <body>
          <h2>❌ Invalid Veracross Session</h2>
          <p>The session cookies don't appear to be from a valid Veracross login.</p>
          <a href="https://portals.veracross.com/csg/login?return=${encodeURIComponent(req.url)}" class="retry-btn">🔄 Try Login Again</a>
          <p style="margin-top: 20px;"><small>Make sure to complete the full login process.</small></p>
        </body>
        </html>
      `);
      return;
    }

    // Create session data
    const sessionData: SessionData = {
      cookies: cookieHeader,
      userAgent,
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
    };

    // Save session data using our existing credential store structure
    await this.credentialStore.saveCredentials({
      username: this.userEmail,
      password: JSON.stringify(sessionData) // Store session data in password field
    });

    // Send success response
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: #28a745; }
          .auto-close { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="success">
          <h1>🎉 Authentication Successful!</h1>
          <p>Your Veracross session has been securely stored for user: <strong>${this.userEmail}</strong></p>
          
          <div class="auto-close">
            <p><strong>✨ Auto-closing in <span id="countdown">5</span> seconds...</strong></p>
            <button onclick="closeNow()" style="background: #007cba; color: white; border: none; padding: 10px 20px; border-radius: 3px; cursor: pointer;">
              Close Now
            </button>
          </div>
          
          <p>🚀 You can now use the CSG Portal MCP tools in Claude!</p>
        </div>
        
        <script>
          let countdown = 5;
          const countdownEl = document.getElementById('countdown');
          
          function updateCountdown() {
            countdown--;
            if (countdownEl) {
              countdownEl.textContent = countdown;
            }
            
            if (countdown <= 0) {
              closeNow();
            } else {
              setTimeout(updateCountdown, 1000);
            }
          }
          
          function closeNow() {
            // Try to close the window
            window.close();
            
            // If close doesn't work (some browsers block it), show message
            setTimeout(() => {
              document.body.innerHTML = \`
                <div style="text-align: center; padding: 50px; font-family: Arial, sans-serif;">
                  <h2>✅ Authentication Complete</h2>
                  <p>You can now close this browser tab manually and return to Claude.</p>
                  <button onclick="window.close()" style="background: #dc3545; color: white; border: none; padding: 15px 30px; border-radius: 5px; cursor: pointer; font-size: 16px;">
                    🗙 Close This Tab
                  </button>
                </div>
              \`;
            }, 500);
          }
          
          // Start countdown
          setTimeout(updateCountdown, 1000);
        </script>
      </body>
      </html>
    `);

    // Resolve the authentication promise
    if (this.authResolve) {
      this.authResolve(true);
    }

    // Close the server after a short delay
    setTimeout(() => {
      this.close();
    }, 2000);
  }

  private async handleLoginSubmission(req: express.Request, res: express.Response) {
    const { username, password } = req.body;
    console.error(`Login attempt for user: ${this.userEmail} with username: ${username}`);
    
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    try {
      // Create a temporary cookie jar for this login attempt
      const tempCookieJar = new CookieJar();
      const baseUrl = 'https://portals.veracross.com/csg';
      
      // Step 1: Get the login page to extract any CSRF tokens or hidden fields
      const loginPageResponse = await this.makeRequestWithJar(tempCookieJar, `${baseUrl}/login`);
      const loginPageHtml = await loginPageResponse.text();
      
      // Extract hidden form fields (CSRF tokens, etc.)
      const hiddenFields = this.extractHiddenFields(loginPageHtml);
      
      // Step 2: Submit login credentials
      const loginData = new URLSearchParams({
        username: username,
        password: password,
        ...hiddenFields,
      });

      const loginResponse = await this.makeRequestWithJar(tempCookieJar, `${baseUrl}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${baseUrl}/login`,
        },
        body: loginData.toString(),
        redirect: 'manual', // Handle redirects manually to check for success
      });

      // Step 3: Check if login was successful
      let loginSuccessful = false;
      
      if (loginResponse.status === 302) {
        const location = loginResponse.headers.get('location');
        if (location && !location.includes('login')) {
          loginSuccessful = true;
        }
      } else if (loginResponse.status === 200) {
        const responseText = await loginResponse.text();
        // Check if the response contains error indicators
        if (!responseText.includes('Invalid') && !responseText.includes('incorrect') && 
            !responseText.includes('error') && responseText.includes('parent')) {
          loginSuccessful = true;
        }
      }

      if (!loginSuccessful) {
        console.error(`Login failed for user: ${this.userEmail} - invalid credentials`);
        return res.status(401).json({
          success: false,
          message: 'Invalid username or password'
        });
      }

      console.error(`Login successful for user: ${this.userEmail} - capturing session`);

      // Step 4: Get session cookies from the successful login
      const cookieString = await tempCookieJar.getCookieString(baseUrl);
      
      if (!cookieString || !this.isValidVeracrossSession(cookieString)) {
        return res.status(500).json({
          success: false,
          message: 'Login succeeded but failed to capture session'
        });
      }

      // Step 5: Store the session data
      const sessionData: SessionData = {
        cookies: cookieString,
        userAgent: req.headers['user-agent'] || 'Mozilla/5.0 (compatible; CSG-Portal-MCP)',
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
      };

      await this.credentialStore.saveCredentials({
        username: this.userEmail,
        password: JSON.stringify(sessionData)
      });

      // Success response
      res.json({
        success: true,
        message: 'Login successful and session stored'
      });

      console.error(`Session stored successfully for user: ${this.userEmail}`);

      // Resolve the authentication promise if it exists
      if (this.authResolve) {
        console.error(`Resolving authentication promise for user: ${this.userEmail}`);
        this.authResolve(true);
        
        // Close the server after a short delay to allow the response to be sent
        setTimeout(() => {
          console.error(`Closing auth server for user: ${this.userEmail}`);
          this.close();
        }, 3000);
      } else {
        console.error(`Warning: No authentication promise to resolve for user: ${this.userEmail}`);
      }

    } catch (error) {
      console.error('Veracross login failed:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to connect to Veracross. Please try again.'
      });
    }
  }

  private async makeRequestWithJar(cookieJar: CookieJar, url: string, options: any = {}) {
    const cookies = await cookieJar.getCookieString(url);
    
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
        await cookieJar.setCookie(cookie, url);
      }
    }

    return response;
  }

  private extractHiddenFields(html: string): { [key: string]: string } {
    const hiddenFields: { [key: string]: string } = {};
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

  private isValidVeracrossSession(cookieHeader: string): boolean {
    // Check for common Veracross session cookie patterns
    // This is a basic check - you might want to make it more sophisticated
    return cookieHeader.includes('session') || 
           cookieHeader.includes('auth') || 
           cookieHeader.includes('_veracross') ||
           cookieHeader.includes('JSESSIONID');
  }

  public async startAuthFlow(): Promise<boolean> {
    try {
      // Get an available port
      const port = await getPort({ port: [3000, 3001, 3002, 3003, 3004] });
      
      // Start the server
      this.server = this.app.listen(port);
      console.error(`Browser auth server started on http://localhost:${port} for user: ${this.userEmail}`);

      // Create a promise that resolves when authentication is complete
      this.authPromise = new Promise((resolve) => {
        this.authResolve = resolve;
      });

      // Open the browser to our auth page
      const authUrl = `http://localhost:${port}`;
      await open(authUrl);
      console.error(`Browser opened to ${authUrl} - waiting for user authentication`);

      // Wait for authentication to complete (or timeout after 10 minutes for user convenience)
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          console.error('Browser authentication timed out after 10 minutes');
          resolve(false);
        }, 10 * 60 * 1000);
      });

      console.error('Waiting for authentication promise to resolve...');
      const result = await Promise.race([this.authPromise, timeoutPromise]);
      console.error(`Authentication result: ${result ? 'SUCCESS' : 'FAILED/TIMEOUT'}`);
      
      // Ensure server is closed
      this.close();
      
      return result;
    } catch (error) {
      console.error('Browser auth flow failed:', error);
      this.close();
      return false;
    }
  }

  public close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  public async getStoredSession(): Promise<SessionData | null> {
    try {
      const credentials = await this.credentialStore.loadCredentials();
      if (!credentials || !credentials.password) {
        return null;
      }

      const sessionData: SessionData = JSON.parse(credentials.password);
      
      // Check if session is expired
      if (new Date() > new Date(sessionData.expiresAt)) {
        console.error('Stored session has expired');
        return null;
      }

      return sessionData;
    } catch (error) {
      console.error('Failed to load stored session:', error);
      return null;
    }
  }

  public async createCookieJar(): Promise<CookieJar | null> {
    const sessionData = await this.getStoredSession();
    if (!sessionData) {
      return null;
    }

    const cookieJar = new CookieJar();
    
    // Parse and add cookies to the jar
    const cookies = sessionData.cookies.split(';');
    for (const cookie of cookies) {
      try {
        await cookieJar.setCookie(cookie.trim(), 'https://portals.veracross.com/csg');
      } catch (error) {
        // Skip invalid cookies
      }
    }

    return cookieJar;
  }
}