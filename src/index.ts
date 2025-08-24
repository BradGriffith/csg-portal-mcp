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

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'login',
            description: 'Login to Veracross portal with username and password. Each user\'s credentials are stored separately.',
            inputSchema: {
              type: 'object',
              properties: {
                username: {
                  type: 'string',
                  description: 'Veracross username (usually an email address)',
                },
                password: {
                  type: 'string',
                  description: 'Veracross password',
                },
                userEmail: {
                  type: 'string',
                  description: 'User email address for credential isolation (if different from username)',
                },
              },
              required: ['username', 'password'],
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
                  description: 'User email address for authentication and data isolation',
                },
              },
              required: ['userEmail'],
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
          case 'login':
            return await this.handleLogin(args as { username: string; password: string });

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

  private async handleLogin(args: { username: string; password: string; userEmail?: string }) {
    const success = await this.auth.login(args.username, args.password, args.userEmail);
    const userIdentifier = args.userEmail || args.username;
    
    return {
      content: [
        {
          type: 'text',
          text: success 
            ? `Successfully logged in to Veracross portal for user ${userIdentifier}. Credentials have been securely stored in user-specific storage.`
            : 'Login failed. Please check your username and password.',
        },
      ],
    };
  }

  private async handleDirectorySearch(args: DirectorySearchParams) {
    try {
      const results = await this.directorySearch.search(args);
      
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