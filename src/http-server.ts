#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool,
  CallToolResult,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';

import { VeracrossAuth } from './auth.js';
import { DirectorySearch, DirectorySearchParams } from './directory.js';
import { CalendarSearch, CalendarSearchParams } from './calendar.js';
import { LunchVolunteerSearch, LunchVolunteerParams } from './lunch-volunteers.js';
import { UserManager } from './user-manager.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

class CSGPortalHTTPServer {
  private app: express.Application;
  private server: Server;
  private auth: VeracrossAuth;
  private directorySearch: DirectorySearch;
  private calendarSearch: CalendarSearch;
  private lunchVolunteerSearch: LunchVolunteerSearch;
  private userManager: UserManager;
  private tools: Tool[] = [];

  constructor() {
    this.app = express();
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

    // Initialize services
    const schoolCode = process.env.VERACROSS_SCHOOL_CODE || 'csg';
    const authBaseUrl = `https://accounts.veracross.com/${schoolCode}/portals`;
    this.auth = new VeracrossAuth(authBaseUrl);
    this.directorySearch = new DirectorySearch(this.auth);
    this.calendarSearch = new CalendarSearch(this.auth);
    this.lunchVolunteerSearch = new LunchVolunteerSearch();
    this.userManager = new UserManager();

    this.setupMiddleware();
    this.setupRoutes();
    this.loadTools();
  }

  private setupMiddleware() {
    // Enable CORS for all routes
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://claude.ai'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
    }));

    // Parse JSON bodies
    this.app.use(express.json());

    // Security middleware
    this.app.use(this.authMiddleware.bind(this));

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  private authMiddleware(req: Request, res: Response, next: NextFunction) {
    // Skip auth for health check and OpenAPI spec
    if (req.path === '/health' || req.path === '/openapi.json') {
      return next();
    }

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.MCP_API_KEY;

    if (!expectedKey) {
      console.warn('MCP_API_KEY not set - running without authentication');
      return next();
    }

    if (!apiKey || apiKey !== expectedKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key'
      });
    }

    next();
  }

  private setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // OpenAPI specification
    this.app.get('/openapi.json', (req: Request, res: Response) => {
      res.json(this.getOpenAPISpec());
    });

    // MCP JSON-RPC endpoint
    this.app.post('/mcp', async (req: Request, res: Response) => {
      try {
        const mcpRequest: MCPRequest = req.body;
        const mcpResponse = await this.handleMCPRequest(mcpRequest);
        res.json(mcpResponse);
      } catch (error) {
        const mcpResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: req.body?.id || 0,
          error: {
            code: ErrorCode.InternalError,
            message: error instanceof Error ? error.message : 'Unknown error'
          }
        };
        res.status(500).json(mcpResponse);
      }
    });

    // REST endpoints for each tool (optional - for easier testing)
    this.app.get('/tools', (req: Request, res: Response) => {
      res.json(this.tools);
    });

    this.app.post('/tools/:toolName', async (req: Request, res: Response) => {
      try {
        const toolName = req.params.toolName;
        const args = req.body;
        
        const mcpRequest: MCPRequest = {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args
          }
        };

        const mcpResponse = await this.handleMCPRequest(mcpRequest);
        
        if (mcpResponse.error) {
          return res.status(400).json(mcpResponse.error);
        }
        
        res.json(mcpResponse.result);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Endpoint ${req.method} ${req.path} not found`
      });
    });

    // Error handler
    this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
      console.error('Unhandled error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    });
  }

  private async handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: { tools: this.tools }
          };

        case 'tools/call':
          const { name, arguments: args } = request.params;
          const result = await this.callTool(name, args);
          return {
            jsonrpc: '2.0',
            id: request.id,
            result
          };

        default:
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: `Unknown method: ${request.method}`
            }
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: ErrorCode.InternalError,
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  private async callTool(name: string, args: any): Promise<CallToolResult> {
    switch (name) {
      case 'login':
      case 'authenticate_browser':
        return await this.handleBrowserAuthentication(args);

      case 'set_default_user':
        return await this.handleSetDefaultUser(args);

      case 'check_authentication':
        return await this.handleCheckAuthentication(args);

      case 'search_directory':
      case 'directory_search':
        return await this.handleDirectorySearch(args);

      case 'school_events':
      case 'upcoming_events':
        return await this.handleUpcomingEvents(args);

      case 'lunch_volunteers':
      case 'ls_lunch_volunteer':
        return await this.handleLunchVolunteers(args);

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
  }

  private loadTools() {
    this.tools = [
      {
        name: 'login',
        description: 'Log in to the CSG Veracross portal. Opens your browser for secure authentication - your credentials never appear in Claude.',
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
        name: 'search_directory',
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
        name: 'school_events',
        description: 'Check upcoming school calendar events. By default searches the next 3 months, automatically extends to 12 months if no events found.',
        inputSchema: {
          type: 'object',
          properties: {
            searchMonths: {
              type: 'number',
              description: 'Number of months to search ahead (default: 3, fallback: 12)',
            },
            refresh: {
              type: 'boolean',
              description: 'Set to true to bypass cache and fetch fresh results',
            },
            userEmail: {
              type: 'string',
              description: 'User email address for authentication (optional if you have a default user set)',
            },
          },
          required: [],
        },
      },
      {
        name: 'lunch_volunteers',
        description: 'Check Lower School lunch volunteer opportunities. Shows only days that need volunteers (open slots) for Salad/deli and Soup positions at 10:45am-11:45am in the dining hall.',
        inputSchema: {
          type: 'object',
          properties: {
            refresh: {
              type: 'boolean',
              description: 'Get the latest volunteer data (bypasses cache)',
            },
            date: {
              type: 'string',
              description: 'Check a specific date in YYYY-MM-DD format (e.g., "2025-08-27")',
            },
            week: {
              type: 'string',
              description: 'Check a week: "this" (current Sunday-Saturday), "next" (next Sunday-Saturday), or specific date to find week containing that date',
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
    ];
  }

  // Tool handlers (reuse logic from original MCP server)
  private async resolveUserEmail(providedEmail?: string): Promise<{ email: string; isAutoDetected: boolean }> {
    if (providedEmail) {
      await this.userManager.updateLastUsed(providedEmail);
      return { email: providedEmail, isAutoDetected: false };
    }
    
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
          } as TextContent,
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to set default user: ${error instanceof Error ? error.message : String(error)}`,
          } as TextContent,
        ],
      };
    }
  }

  private async handleBrowserAuthentication(args: { userEmail?: string }) {
    try {
      const { email, isAutoDetected } = await this.resolveUserEmail(args.userEmail);
      
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
          } as TextContent,
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Browser authentication error: ${error instanceof Error ? error.message : String(error)}`,
          } as TextContent,
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
              : `❌ No stored authentication session found for ${email}${autoDetectedMsg}. Please use the login tool first.`,
          } as TextContent,
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error checking authentication: ${error instanceof Error ? error.message : String(error)}`,
          } as TextContent,
        ],
      };
    }
  }

  private async handleDirectorySearch(args: DirectorySearchParams) {
    try {
      const { email } = await this.resolveUserEmail(args.userEmail);
      
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
            } as TextContent,
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
          } as TextContent,
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Directory search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleUpcomingEvents(args: CalendarSearchParams) {
    try {
      const { email } = await this.resolveUserEmail(args.userEmail);
      
      const searchParams: CalendarSearchParams = {
        ...args,
        userEmail: email
      };
      
      const events = await this.calendarSearch.searchUpcomingEvents(searchParams);
      
      if (events.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No upcoming events found in the school calendar.',
            } as TextContent,
          ],
        };
      }
      
      const eventsText = events.map(event => {
        const parts = [`Title: ${event.title}`];
        
        const startDate = new Date(event.startDate);
        const dateStr = startDate.toLocaleDateString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        });
        parts.push(`Date: ${dateStr}`);
        
        if (!event.allDay && event.startTime) {
          parts.push(`Time: ${event.startTime}${event.endTime ? ` - ${event.endTime}` : ''}`);
        } else if (event.allDay) {
          parts.push(`All Day Event`);
        }
        
        if (event.location) parts.push(`Location: ${event.location}`);
        if (event.description) parts.push(`Description: ${event.description}`);
        if (event.category) parts.push(`Category: ${event.category}`);
        
        return parts.join('\n');
      }).join('\n\n---\n\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `Found ${events.length} upcoming events:\n\n${eventsText}`,
          } as TextContent,
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Calendar search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleLunchVolunteers(args: LunchVolunteerParams) {
    try {
      const slots = await this.lunchVolunteerSearch.searchVolunteerSlots(args);
      
      if (slots.length === 0) {
        let noResultsMessage = 'No lunch volunteer slots found';
        
        if (args.date) {
          noResultsMessage += ` for ${this.formatSlotDate(args.date)}`;
        } else if (args.week === 'this') {
          noResultsMessage += ' for this week (Sunday through Saturday)';
        } else if (args.week === 'next') {
          noResultsMessage += ' for next week (Sunday through Saturday)';
        } else if (args.week) {
          noResultsMessage += ` for the week containing ${args.week}`;
        } else {
          noResultsMessage += '. This could mean either:\n\n• No volunteer slots are currently posted\n• The SignUpGenius page structure has changed\n• The signup period has ended\n\nTry checking the SignUpGenius page directly or contact the school for current volunteer opportunities.';
        }
        
        return {
          content: [
            {
              type: 'text',
              text: noResultsMessage + '.',
            } as TextContent,
          ],
        };
      }
      
      const slotsText = slots.map(slot => {
        const parts = [`**${slot.dayOfWeek}, ${this.formatSlotDate(slot.date)}**`];
        parts.push(`Time: ${slot.time}`);
        parts.push(`Location: ${slot.location}`);
        parts.push('');
        
        slot.slots.forEach(position => {
          const statusEmoji = position.status === 'full' ? '🔴' : '🟢';
          const availabilityText = position.status === 'full' 
            ? `All ${position.slotsTotal} slots filled` 
            : `${position.slotsAvailable} of ${position.slotsTotal} slots available`;
            
          parts.push(`${statusEmoji} **${position.position}**: ${availabilityText}`);
          
          if (position.volunteers.length > 0) {
            parts.push(`   Volunteers: ${position.volunteers.join(', ')}`);
          }
        });
        
        return parts.join('\n');
      }).join('\n\n---\n\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `Lower School Lunch Volunteer Slots:\n\n${slotsText}`,
          } as TextContent,
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Lunch volunteer search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private formatSlotDate(dateString: string): string {
    try {
      const [year, month, day] = dateString.split('-').map(Number);
      if (!year || !month || !day) return dateString;
      
      const date = new Date(year, month - 1, day);
      return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
    } catch (error) {
      return dateString;
    }
  }

  private async handleLogout() {
    this.auth.logout();
    
    return {
      content: [
        {
          type: 'text',
          text: 'Successfully logged out from Veracross portal.',
        } as TextContent,
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
        } as TextContent,
      ],
    };
  }

  private getOpenAPISpec() {
    return {
      openapi: '3.0.0',
      info: {
        title: 'CSG Portal MCP Server',
        version: '1.0.0',
        description: 'HTTP API wrapper for CSG Portal MCP Server - provides access to Columbus School for Girls Veracross portal directory search, calendar events, and lunch volunteer tools'
      },
      servers: [
        {
          url: process.env.API_BASE_URL || 'http://localhost:3000',
          description: 'MCP HTTP Server'
        }
      ],
      security: [
        {
          ApiKeyAuth: []
        }
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key'
          }
        }
      },
      paths: {
        '/health': {
          get: {
            summary: 'Health check',
            responses: {
              200: {
                description: 'Service is healthy'
              }
            }
          }
        },
        '/mcp': {
          post: {
            summary: 'MCP JSON-RPC endpoint',
            description: 'Execute MCP protocol requests using JSON-RPC format',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jsonrpc: { type: 'string', enum: ['2.0'] },
                      id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                      method: { type: 'string' },
                      params: { type: 'object' }
                    },
                    required: ['jsonrpc', 'id', 'method']
                  }
                }
              }
            },
            responses: {
              200: {
                description: 'MCP response'
              }
            }
          }
        },
        '/tools': {
          get: {
            summary: 'List all available tools',
            responses: {
              200: {
                description: 'List of available tools'
              }
            }
          }
        },
        '/tools/{toolName}': {
          post: {
            summary: 'Execute a specific tool',
            parameters: [
              {
                name: 'toolName',
                in: 'path',
                required: true,
                schema: {
                  type: 'string'
                }
              }
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    description: 'Tool arguments'
                  }
                }
              }
            },
            responses: {
              200: {
                description: 'Tool execution result'
              }
            }
          }
        }
      }
    };
  }

  public start(port: number = 3000): void {
    this.app.listen(port, () => {
      console.log(`CSG Portal MCP HTTP Server running on port ${port}`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`OpenAPI spec: http://localhost:${port}/openapi.json`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    });
  }

  public getApp(): express.Application {
    return this.app;
  }

  public async close(): Promise<void> {
    await this.auth.close();
  }
}

// Export for serverless deployment
export default function handler(req: Request, res: Response) {
  const server = new CSGPortalHTTPServer();
  return server.getApp()(req as any, res as any);
}

// Start server if running directly
if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const server = new CSGPortalHTTPServer();
  const port = parseInt(process.env.PORT || '3000');
  server.start(port);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await server.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    await server.close();
    process.exit(0);
  });
}