import type { Handler } from '@netlify/functions';
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';

// Encryption utilities
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function encrypt(text: string, masterKey: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(masterKey, 'salt', 32);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

async function saveSessionToMongoDB(userEmail: string, sessionData: any) {
  const client = new MongoClient(process.env.MONGODB_URI!);
  
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DATABASE || 'csg_portal');
    const sessions = db.collection('sessions');
    
    // Create user-specific key
    const userKey = crypto.createHash('sha256').update(userEmail.toLowerCase()).digest('hex');
    
    // Encrypt session data
    const encryptedData = encrypt(JSON.stringify(sessionData), process.env.ENCRYPTION_MASTER_KEY!);
    
    await sessions.updateOne(
      { userKey },
      {
        $set: {
          userKey,
          encryptedSession: encryptedData,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } finally {
    await client.close();
  }
}

export const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { username, password, userEmail } = JSON.parse(event.body || '{}');
    
    if (!username || !password || !userEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Create cookie jar for session management
    const cookieJar = new CookieJar();
    const baseUrl = process.env.VERACROSS_BASE_URL || 'https://portals.veracross.com/csg';
    
    // Step 1: Get login page to retrieve CSRF token
    const loginPageResponse = await fetch(`${baseUrl}/login`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CSG-Portal-MCP/1.0)',
      }
    });
    
    const loginPageText = await loginPageResponse.text();
    
    // Extract CSRF token from login page
    const csrfMatch = loginPageText.match(/<meta name="csrf-token" content="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    
    // Extract session cookies
    const setCookies = loginPageResponse.headers.raw()['set-cookie'];
    if (setCookies) {
      for (const cookie of setCookies) {
        await cookieJar.setCookie(cookie, baseUrl);
      }
    }
    
    // Step 2: Submit login form
    const loginResponse = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; CSG-Portal-MCP/1.0)',
        'X-CSRF-Token': csrfToken,
        'Cookie': await cookieJar.getCookieString(baseUrl),
        'Referer': `${baseUrl}/login`,
      },
      body: new URLSearchParams({
        'username': username,
        'password': password,
        'authenticity_token': csrfToken,
        'commit': 'Sign In',
      }).toString(),
      redirect: 'manual',
    });
    
    // Check if login was successful (usually redirects on success)
    const loginSuccess = loginResponse.status === 302 || loginResponse.status === 303;
    
    if (loginSuccess) {
      // Save session cookies
      const loginCookies = loginResponse.headers.raw()['set-cookie'];
      if (loginCookies) {
        for (const cookie of loginCookies) {
          await cookieJar.setCookie(cookie, baseUrl);
        }
      }
      
      // Store session in MongoDB
      const cookies = await cookieJar.getCookies(baseUrl);
      const sessionData = {
        cookies: cookies.map(c => c.toJSON()),
        csrfToken,
        timestamp: Date.now()
      };
      
      await saveSessionToMongoDB(userEmail, sessionData);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Authentication successful' })
      };
    } else {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, message: 'Invalid credentials' })
      };
    }
  } catch (error) {
    console.error('Login error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        message: error instanceof Error ? error.message : 'Login failed' 
      })
    };
  }
};