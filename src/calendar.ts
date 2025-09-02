import { VeracrossAuth } from './auth.js';
import { MongoSearchCache } from './mongodb-cache.js';

export interface CalendarSearchParams {
  beginDate?: Date; // Start date for event search
  endDate?: Date; // End date for event search
  searchMonths?: number; // Number of months to search (default 3, fallback to 12)
  refresh?: boolean; // Optional parameter to bypass cache
  userEmail?: string; // User email for authentication and isolation
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startDate: string; // ISO date string
  endDate?: string; // ISO date string
  startTime?: string;
  endTime?: string;
  location?: string;
  allDay: boolean;
  category?: string;
  url?: string;
}

export class CalendarSearch {
  private auth: VeracrossAuth;
  private cache?: MongoSearchCache;
  private currentUserEmail?: string;

  constructor(auth: VeracrossAuth) {
    this.auth = auth;
  }

  private ensureCache(userEmail: string): void {
    if (!this.cache || this.currentUserEmail !== userEmail) {
      this.cache = new MongoSearchCache(userEmail);
      this.currentUserEmail = userEmail;
    }
  }

  private formatDateForUrl(date: Date): string {
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${month}%2F${day}%2F${year}`; // URL-encoded MM/DD/YYYY
  }

  private buildCalendarUrl(beginDate: Date, endDate: Date): string {
    const schoolCode = process.env.VERACROSS_SCHOOL_CODE || 'csg';
    const beginDateStr = this.formatDateForUrl(beginDate);
    const endDateStr = this.formatDateForUrl(endDate);
    
    return `https://portals.veracross.com/${schoolCode}/parent/calendar/household/events?begin_date=${beginDateStr}&end_date=${endDateStr}`;
  }

  public async searchUpcomingEvents(params: CalendarSearchParams): Promise<CalendarEvent[]> {
    try {
      // User email is required for authentication and isolation
      if (!params.userEmail) {
        throw new Error('User email is required for calendar search');
      }

      // Ensure cache is set up for this user
      this.ensureCache(params.userEmail);

      // Calculate date range
      const beginDate = params.beginDate || new Date();
      const searchMonths = params.searchMonths || 3;
      const endDate = params.endDate || new Date(beginDate.getTime());
      if (!params.endDate) {
        endDate.setMonth(endDate.getMonth() + searchMonths);
      }

      // Create cache key
      const cacheKey = {
        tool: 'calendar',
        beginDate: beginDate.toISOString(),
        endDate: endDate.toISOString(),
        userEmail: params.userEmail
      };

      // Check cache first (unless refresh is requested)
      if (!params.refresh) {
        const cachedResults = await this.cache!.get(cacheKey) as CalendarEvent[] | null;
        if (cachedResults) {
          const cacheInfo = await this.cache!.getCacheInfo(cacheKey);
          // Use stderr for logging to avoid corrupting JSON-RPC on stdout
          console.error(`Calendar search returned ${cachedResults.length} cached events for user ${params.userEmail} (age: ${cacheInfo.age}min, expires in: ${cacheInfo.expiresIn}min)`);
          return cachedResults;
        }
      }

      await this.auth.ensureAuthenticated(params.userEmail);

      // Make authenticated request to calendar API
      const calendarUrl = this.buildCalendarUrl(beginDate, endDate);
      const response = await this.auth.makeAuthenticatedRequest(calendarUrl);
      
      if (!response.ok) {
        throw new Error(`Calendar search request failed: ${response.status}`);
      }

      const jsonData = await response.json() as any;
      
      // Parse the JSON response
      let events = this.parseCalendarEvents(jsonData);
      
      // If no events found and we were searching 3 months, try 12 months
      if (events.length === 0 && searchMonths === 3 && !params.searchMonths) {
        console.error('No events found in next 3 months, searching next 12 months...');
        const extendedEndDate = new Date(beginDate.getTime());
        extendedEndDate.setMonth(extendedEndDate.getMonth() + 12);
        
        const extendedUrl = this.buildCalendarUrl(beginDate, extendedEndDate);
        const extendedResponse = await this.auth.makeAuthenticatedRequest(extendedUrl);
        
        if (extendedResponse.ok) {
          const extendedData = await extendedResponse.json() as any;
          events = this.parseCalendarEvents(extendedData);
          
          // Update cache key for extended search
          const extendedCacheKey = {
            ...cacheKey,
            endDate: extendedEndDate.toISOString()
          };
          
          // Cache the extended results
          await this.cache!.set(extendedCacheKey, events as any, 24);
          console.error(`Calendar search fetched ${events.length} events (12-month extended search) for user ${params.userEmail} and cached for 24 hours`);
          return events;
        }
      }
      
      // Cache the results for 24 hours
      await this.cache!.set(cacheKey, events as any, 24);
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout
      console.error(`Calendar search fetched ${events.length} fresh events for user ${params.userEmail} and cached for 24 hours`);
      
      return events;
    } catch (error) {
      console.error('Calendar search failed:', error);
      throw error;
    }
  }

  private parseCalendarEvents(data: any): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    
    // Handle both array and object responses
    const eventList = Array.isArray(data) ? data : (data.events || []);
    
    for (const item of eventList) {
      // Parse based on actual Veracross calendar JSON structure
      const event: CalendarEvent = {
        id: item.id || item.event_id || item.record_identifier || '',
        title: item.description || item.title || item.summary || item.tooltip || '',
        description: item.tooltip !== item.description ? item.tooltip : undefined,
        startDate: this.convertDateFormat(item.start_date || item.start || ''),
        endDate: this.convertDateFormat(item.end_date || item.end || ''),
        startTime: item.start_time || undefined,
        endTime: item.end_time || undefined,
        location: item.location || item.venue || undefined,
        allDay: item.start_time === null && item.end_time === null,
        category: item.category || item.event_type || item.type || undefined,
        url: item.event_url || item.url || item.link || undefined
      };
      
      // Only include events with at least an ID and title
      if (event.id && event.title) {
        events.push(event);
      }
    }
    
    // Sort events by start date
    events.sort((a, b) => {
      const dateA = new Date(a.startDate);
      const dateB = new Date(b.startDate);
      return dateA.getTime() - dateB.getTime();
    });
    
    return events;
  }

  private convertDateFormat(dateString: string): string {
    if (!dateString) return '';
    
    // Convert MM/DD/YYYY to ISO format
    if (dateString.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
      const [month, day, year] = dateString.split('/');
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day)).toISOString();
    }
    
    return dateString;
  }
}