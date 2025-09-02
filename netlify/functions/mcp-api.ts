import type { Handler } from '@netlify/functions';
import { VeracrossAuth } from '../../src/auth.js';
import { DirectorySearch } from '../../src/directory.js';
import { CalendarSearch } from '../../src/calendar.js';
import { LunchVolunteerSearch } from '../../src/lunch-volunteers.js';
import { UserManager } from '../../src/user-manager.js';

const auth = new VeracrossAuth(process.env.VERACROSS_BASE_URL || 'https://portals.veracross.com/csg');
const directorySearch = new DirectorySearch(auth);
const calendarSearch = new CalendarSearch(auth);
const lunchVolunteerSearch = new LunchVolunteerSearch();
const userManager = new UserManager();

interface MCPRequest {
  method: string;
  params?: Record<string, any>;
}

interface MCPResponse {
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

const handleTool = async (toolName: string, args: any = {}): Promise<any> => {
  switch (toolName) {
    case 'login':
      const loginEmail = args.userEmail || await userManager.detectUserEmail();
      if (!loginEmail) {
        throw new Error('No user email provided and no default user configured');
      }
      await userManager.addUser(loginEmail, !await userManager.hasUsers());
      const success = await auth.authenticateWithBrowser(loginEmail);
      return {
        success,
        message: success 
          ? `Successfully authenticated for user ${loginEmail}`
          : 'Authentication failed or was cancelled'
      };

    case 'set_default_user':
      if (!args.userEmail) {
        throw new Error('userEmail is required');
      }
      await userManager.setDefaultUser(args.userEmail);
      return {
        success: true,
        message: `Set ${args.userEmail} as default user`
      };

    case 'check_authentication':
      const checkEmail = args.userEmail || await userManager.detectUserEmail();
      if (!checkEmail) {
        throw new Error('No user email provided and no default user configured');
      }
      const hasSession = await auth.hasStoredSession(checkEmail);
      return {
        authenticated: hasSession,
        user: checkEmail
      };

    case 'search_directory':
      const dirEmail = args.userEmail || await userManager.detectUserEmail();
      if (!dirEmail) {
        throw new Error('No user email provided and no default user configured');
      }
      const results = await directorySearch.search({ ...args, userEmail: dirEmail });
      return { results };

    case 'school_events':
      const eventsEmail = args.userEmail || await userManager.detectUserEmail();
      if (!eventsEmail) {
        throw new Error('No user email provided and no default user configured');
      }
      const events = await calendarSearch.searchUpcomingEvents({ ...args, userEmail: eventsEmail });
      return { events };

    case 'lunch_volunteers':
      const slots = await lunchVolunteerSearch.searchVolunteerSlots(args);
      return { slots };

    case 'logout':
      auth.logout();
      return { success: true, message: 'Logged out successfully' };

    case 'clear_credentials':
      await auth.clearStoredCredentials();
      return { success: true, message: 'Credentials cleared' };

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};

export const handler: Handler = async (event) => {
  // Enable CORS for Claude.ai
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  // Handle GET request for tool discovery
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: 'CSG Portal MCP',
        version: '1.0.0',
        tools: [
          {
            name: 'login',
            description: 'Log in to the CSG Veracross portal',
            parameters: {
              type: 'object',
              properties: {
                userEmail: { type: 'string', description: 'Your email address' }
              }
            }
          },
          {
            name: 'set_default_user',
            description: 'Set a default user email',
            parameters: {
              type: 'object',
              properties: {
                userEmail: { type: 'string', description: 'Email to set as default' }
              },
              required: ['userEmail']
            }
          },
          {
            name: 'check_authentication',
            description: 'Check authentication status',
            parameters: {
              type: 'object',
              properties: {
                userEmail: { type: 'string', description: 'Email to check (optional)' }
              }
            }
          },
          {
            name: 'search_directory',
            description: 'Search the CSG directory',
            parameters: {
              type: 'object',
              properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                city: { type: 'string' },
                postalCode: { type: 'string' },
                gradeLevel: { type: 'string' },
                refresh: { type: 'boolean' },
                userEmail: { type: 'string' }
              }
            }
          },
          {
            name: 'school_events',
            description: 'Get upcoming school events',
            parameters: {
              type: 'object',
              properties: {
                searchMonths: { type: 'number' },
                refresh: { type: 'boolean' },
                userEmail: { type: 'string' }
              }
            }
          },
          {
            name: 'lunch_volunteers',
            description: 'Check lunch volunteer opportunities',
            parameters: {
              type: 'object',
              properties: {
                refresh: { type: 'boolean' },
                date: { type: 'string' },
                week: { type: 'string' }
              }
            }
          },
          {
            name: 'logout',
            description: 'Logout from portal',
            parameters: { type: 'object', properties: {} }
          },
          {
            name: 'clear_credentials',
            description: 'Clear stored credentials',
            parameters: { type: 'object', properties: {} }
          }
        ]
      })
    };
  }

  // Handle POST request for tool execution
  if (event.httpMethod === 'POST') {
    try {
      const request: MCPRequest = JSON.parse(event.body || '{}');
      
      if (!request.method) {
        throw new Error('Method name is required');
      }

      const result = await handleTool(request.method, request.params);
      
      const response: MCPResponse = { result };
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(response),
      };
    } catch (error) {
      const response: MCPResponse = {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(response),
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
};