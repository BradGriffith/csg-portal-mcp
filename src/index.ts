#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { VeracrossAuth } from './auth.js';
import { DirectorySearch, DirectorySearchParams } from './directory.js';
import { UserManager } from './user-manager.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with absolute path
dotenv.config({ path: join(__dirname, '../.env') });

class CSGPortalMCPServer {
  private server: Server;
  private auth: VeracrossAuth;
  private directorySearch: DirectorySearch;
  private userManager: UserManager;

  constructor() {
    this.server = new Server(
      {
        name: 'csg-portal-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize with base URL from environment or default
    const baseUrl = process.env.VERACROSS_BASE_URL || 'https://portals.veracross.com/csg';
    this.auth = new VeracrossAuth(baseUrl);
    this.directorySearch = new DirectorySearch(this.auth);
    this.userManager = new UserManager();

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'authenticate_browser',
            description: 'Open browser for secure Veracross authentication. Your credentials never appear in Claude - you log in normally via your browser.',
            inputSchema: {
              type: 'object',
              properties: {
                userEmail: {
                  type: 'string',
                  description: 'Your email address for session isolation and identification (optional if you have a default user set)',
                },
              },
              required: [],
            },
          },
          {
            name: 'set_default_user',
            description: 'Set a default user email so you don\'t need to provide it every time. This email will be used for all authentication and directory searches.',
            inputSchema: {
              type: 'object',
              properties: {
                userEmail: {
                  type: 'string',
                  description: 'Your email address to set as the default user',
                },
              },
              required: ['userEmail'],
            },
          },
          {
            name: 'list_users',
            description: 'List all users that have been configured, showing which is the default.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'check_authentication',
            description: 'Check if you have a valid stored authentication session.',
            inputSchema: {
              type: 'object',
              properties: {
                userEmail: {
                  type: 'string',
                  description: 'Your email address to check authentication status for (optional if you have a default user set)',
                },
              },
              required: [],
            },
          },
          {
            name: 'directory_search',
            description: 'Search the CSG directory for students, parents, and staff. Results are cached for 24 hours by default. CSG uses Forms (not grades) with 4 schools: PYC (ages 3/4, 4/5), Lower School (Forms I-V), Middle School (Forms VI-VIII), Upper School (Forms IX-XII).',
            inputSchema: {
              type: 'object',
              properties: {
                firstName: {
                  type: 'string',
                  description: 'First name to search for',
                },
                lastName: {
                  type: 'string',
                  description: 'Last name to search for',
                },
                city: {
                  type: 'string',
                  description: 'City to search for',
                },
                postalCode: {
                  type: 'string',
                  description: 'Postal code to search for',
                },
                gradeLevel: {
                  type: 'string',
                  description: 'Form level to search for. Use CSG format: "3/4 Yr Olds", "4/5 Yr Olds", or Roman numerals "I", "II", "III", "IV", "V" (Lower School), "VI", "VII", "VIII" (Middle School), "IX", "X", "XI", "XII" (Upper School)',
                },
                refresh: {
                  type: 'boolean',
                  description: 'Set to true to bypass cache and fetch fresh results',
                },
                userEmail: {
                  type: 'string',
                  description: 'User email address for authentication and data isolation (optional if you have a default user set)',
                },
              },
              required: [],
            },
          },
          {
            name: 'logout',
            description: 'Logout from Veracross portal and clear session',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'clear_credentials',
            description: 'Clear stored login credentials',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'authenticate_browser':
            return await this.handleBrowserAuthentication(args as { userEmail?: string });

          case 'set_default_user':
            return await this.handleSetDefaultUser(args as { userEmail: string });

          case 'list_users':
            return await this.handleListUsers();

          case 'check_authentication':
            return await this.handleCheckAuthentication(args as { userEmail?: string });

          case 'directory_search':
            return await this.handleDirectorySearch(args as DirectorySearchParams);

          case 'logout':
            return await this.handleLogout();

          case 'clear_credentials':
            return await this.handleClearCredentials();

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async resolveUserEmail(providedEmail?: string): Promise<{ email: string; isAutoDetected: boolean }> {
    if (providedEmail) {
      // Update last used timestamp for this user
      await this.userManager.updateLastUsed(providedEmail);
      return { email: providedEmail, isAutoDetected: false };
    }
    
    // Try to auto-detect user email
    const detectedEmail = await this.userManager.detectUserEmail();
    if (detectedEmail) {
      return { email: detectedEmail, isAutoDetected: true };
    }
    
    throw new Error('No user email provided and no default user configured. Please use set_default_user first or provide userEmail parameter.');
  }

  private async handleSetDefaultUser(args: { userEmail: string }) {
    try {
      await this.userManager.setDefaultUser(args.userEmail);
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully set ${args.userEmail} as the default user. You can now use authentication and directory search tools without specifying an email.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to set default user: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private async handleListUsers() {
    try {
      const users = await this.userManager.getAllUsers();
      
      if (users.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No users configured yet. Use set_default_user to add your first user.',
            },
          ],
        };
      }
      
      const userList = users.map(user => {
        const defaultIndicator = user.isDefault ? ' (DEFAULT)' : '';
        const lastUsed = user.lastUsed.toLocaleDateString();
        return `• ${user.email}${defaultIndicator} - Last used: ${lastUsed}`;
      }).join('\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `Configured users:\n\n${userList}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to list users: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private async handleBrowserAuthentication(args: { userEmail?: string }) {
    try {
      const { email, isAutoDetected } = await this.resolveUserEmail(args.userEmail);
      
      // Add user to manager when they authenticate (if not already there)
      await this.userManager.addUser(email, !await this.userManager.hasUsers());
      
      const success = await this.auth.authenticateWithBrowser(email);
      
      const autoDetectedMsg = isAutoDetected ? ` (auto-detected from default user)` : '';
      
      return {
        content: [
          {
            type: 'text',
            text: success 
              ? `🎉 Successfully authenticated via browser for user ${email}${autoDetectedMsg}! Your Veracross session has been securely stored and you can now use directory search.`
              : '❌ Browser authentication failed or was cancelled. Please try again and make sure to complete the login process in your browser.',
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Browser authentication error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private async handleCheckAuthentication(args: { userEmail?: string }) {
    try {
      const { email, isAutoDetected } = await this.resolveUserEmail(args.userEmail);
      const hasStoredSession = await this.auth.hasStoredSession(email);
      
      const autoDetectedMsg = isAutoDetected ? ` (auto-detected from default user)` : '';
      
      return {
        content: [
          {
            type: 'text',
            text: hasStoredSession
              ? `✅ You have a valid stored authentication session for ${email}${autoDetectedMsg}. You can use directory search without re-authenticating.`
              : `❌ No stored authentication session found for ${email}${autoDetectedMsg}. Please use the authenticate_browser tool first.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error checking authentication: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private async handleDirectorySearch(args: DirectorySearchParams) {
    try {
      // Resolve user email if not provided
      const { email } = await this.resolveUserEmail(args.userEmail);
      
      // Create search params with resolved email
      const searchParams: DirectorySearchParams = {
        ...args,
        userEmail: email
      };
      
      const results = await this.directorySearch.search(searchParams);
      
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No directory entries found matching the search criteria.',
            },
          ],
        };
      }

      const resultsText = results.map(entry => {
        const parts = [`Name: ${entry.name}`];
        if (entry.email) parts.push(`Email: ${entry.email}`);
        if (entry.phone) parts.push(`Phone: ${entry.phone}`);
        if (entry.gradeLevel) parts.push(`Grade: ${entry.gradeLevel}`);
        if (entry.city) parts.push(`City: ${entry.city}`);
        if (entry.postalCode) parts.push(`Postal Code: ${entry.postalCode}`);
        if (entry.address) parts.push(`Address: ${entry.address}`);
        if (entry.class) parts.push(`Class: ${entry.class}`);
        
        return parts.join('\n');
      }).join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} directory entries:\n\n${resultsText}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Directory search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleLogout() {
    this.auth.logout();
    
    return {
      content: [
        {
          type: 'text',
          text: 'Successfully logged out from Veracross portal.',
        },
      ],
    };
  }

  private async handleClearCredentials() {
    await this.auth.clearStoredCredentials();
    
    return {
      content: [
        {
          type: 'text',
          text: 'Stored credentials have been cleared.',
        },
      ],
    };
  }

  public async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('CSG Portal MCP Server running on stdio');
  }
}

// Future tool placeholders - ready for implementation

/*
// Calendar functionality - JSON API endpoints
export class CalendarTools {
  constructor(private auth: VeracrossAuth) {}
  
  async getCalendarEvents(startDate: string, endDate: string) {
    // Implementation for calendar JSON API
  }
}

// Daily schedule functionality - URL-based scraping
export class ScheduleTools {
  constructor(private auth: VeracrossAuth) {}
  
  async getDailySchedule(date: string) {
    // Implementation for daily schedule scraping
  }
}

// Lunch menu functionality - JSON API, no auth required
export class LunchMenuTools {
  async getLunchMenu(date: string) {
    // Implementation for lunch menu JSON API
  }
}
*/

const server = new CSGPortalMCPServer();
server.run().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});