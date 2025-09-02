import type { Handler } from '@netlify/functions';
import { VeracrossAuth } from '../../src/auth.js';

const auth = new VeracrossAuth(process.env.VERACROSS_BASE_URL || 'https://portals.veracross.com/csg');

export const handler: Handler = async (event) => {
  const headers = {
    'Content-Type': 'text/html',
  };

  // This endpoint handles the browser authentication flow
  if (event.httpMethod === 'GET') {
    const userEmail = event.queryStringParameters?.email;
    const action = event.queryStringParameters?.action;

    if (action === 'login' && userEmail) {
      // Generate login form HTML
      return {
        statusCode: 200,
        headers,
        body: `
<!DOCTYPE html>
<html>
<head>
  <title>CSG Portal Login</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .login-container {
      background: white;
      padding: 2rem;
      border-radius: 12px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
      max-width: 400px;
      width: 100%;
    }
    h2 {
      color: #333;
      margin-bottom: 1.5rem;
      text-align: center;
    }
    .form-group {
      margin-bottom: 1rem;
    }
    label {
      display: block;
      margin-bottom: 0.5rem;
      color: #555;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
      box-sizing: border-box;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5a67d8;
    }
    .info {
      margin-top: 1rem;
      padding: 1rem;
      background: #f0f4ff;
      border-radius: 6px;
      color: #555;
      font-size: 0.875rem;
    }
    .success {
      background: #d4edda;
      color: #155724;
      padding: 1rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      text-align: center;
    }
    .error {
      background: #f8d7da;
      color: #721c24;
      padding: 1rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h2>CSG Portal Login</h2>
    <form id="loginForm" action="/api/veracross-login" method="POST">
      <input type="hidden" name="userEmail" value="${userEmail}">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit">Login</button>
    </form>
    <div class="info">
      Your credentials are securely transmitted and never stored by Claude. Only session tokens are retained for future use.
    </div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const button = e.target.querySelector('button');
      button.disabled = true;
      button.textContent = 'Logging in...';
      
      try {
        const response = await fetch('/.netlify/functions/veracross-login', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(formData)),
          headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
          document.querySelector('.login-container').innerHTML = 
            '<div class="success">Authentication successful! You can close this window.</div>' +
            '<script>setTimeout(() => window.close(), 2000);</' + 'script>';
        } else {
          button.disabled = false;
          button.textContent = 'Login';
          alert('Login failed: ' + (result.message || 'Invalid credentials'));
        }
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Login';
        alert('Login error: ' + error.message);
      }
    });
  </script>
</body>
</html>
        `
      };
    }

    return {
      statusCode: 400,
      headers,
      body: '<h1>Invalid request</h1>'
    };
  }

  return {
    statusCode: 405,
    headers,
    body: '<h1>Method not allowed</h1>'
  };
};