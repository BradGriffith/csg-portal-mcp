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
import { CalendarSearch, CalendarSearchParams } from './calendar.js';
import { LunchVolunteerSearch, LunchVolunteerParams } from './lunch-volunteers.js';
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
  private calendarSearch: CalendarSearch;
  private lunchVolunteerSearch: LunchVolunteerSearch;
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
    this.calendarSearch = new CalendarSearch(this.auth);
    this.lunchVolunteerSearch = new LunchVolunteerSearch();
    this.userManager = new UserManager();

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
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
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'login':
          case 'authenticate_browser': // Backward compatibility
            return await this.handleBrowserAuthentication(args as { userEmail?: string });

          case 'set_default_user':
            return await this.handleSetDefaultUser(args as { userEmail: string });

          case 'check_authentication':
            return await this.handleCheckAuthentication(args as { userEmail?: string });

          case 'search_directory':
          case 'directory_search': // Backward compatibility
            return await this.handleDirectorySearch(args as DirectorySearchParams);

          case 'school_events':
          case 'upcoming_events': // Backward compatibility
            return await this.handleUpcomingEvents(args as CalendarSearchParams);

          case 'lunch_volunteers':
          case 'ls_lunch_volunteer': // Backward compatibility
            return await this.handleLunchVolunteers(args as LunchVolunteerParams);

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
              : `❌ No stored authentication session found for ${email}${autoDetectedMsg}. Please use the login tool first.`,
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

  private async handleUpcomingEvents(args: CalendarSearchParams) {
    try {
      // Resolve user email if not provided
      const { email } = await this.resolveUserEmail(args.userEmail);
      
      // Create search params with resolved email
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
            },
          ],
        };
      }
      
      const eventsText = events.map(event => {
        const parts = [`Title: ${event.title}`];
        
        // Format date/time
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
          },
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
            },
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
          },
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
      // Parse YYYY-MM-DD format with explicit components to avoid timezone issues
      const [year, month, day] = dateString.split('-').map(Number);
      if (!year || !month || !day) return dateString;
      
      // Create date with explicit components (month is 0-based)
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