import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

export interface LunchVolunteerParams {
  refresh?: boolean; // Optional parameter to bypass cache
  userEmail?: string; // User email for authentication (though SignUpGenius might not need it)
  date?: string; // Optional specific date to filter by (YYYY-MM-DD)
  week?: string; // Optional week filter: 'this', 'next', or specific date for week containing that date
}

export interface LunchVolunteerSlot {
  date: string; // Date in YYYY-MM-DD format
  dayOfWeek: string;
  time: string; // e.g., "10:45am - 11:45am"
  location: string;
  slots: VolunteerPosition[];
}

export interface VolunteerPosition {
  position: string; // e.g., "Salad/deli", "Soup"
  slotsTotal: number; // Total available slots
  slotsFilled: number; // Number of filled slots
  slotsAvailable: number; // Calculated: total - filled
  volunteers: string[]; // Names of signed up volunteers
  status: 'available' | 'full'; // Derived from button state
}

export class LunchVolunteerSearch {
  private signupPageUrl: string;
  private apiUrl: string;
  private urlId: string;

  constructor() {
    const baseUrl = process.env.LS_LUNCH_SIGNUP_URL || 'https://www.signupgenius.com/go/10C084BADAA2BA2FFC43-57722061-lslunch#/';
    // Extract the URL ID from the signup URL (e.g., 10C084BADAA2BA2FFC43-57722061-lslunch)
    const urlIdMatch = baseUrl.match(/\/go\/([^#\/]+)/);
    if (!urlIdMatch) {
      throw new Error(`Could not extract URL ID from signup URL: ${baseUrl}`);
    }
    
    this.urlId = urlIdMatch[1];
    this.signupPageUrl = baseUrl.replace(/#.*$/, '');
    this.apiUrl = 'https://www.signupgenius.com/SUGboxAPI.cfm?go=s.getSignupInfo';
    
  }

  public async searchVolunteerSlots(params: LunchVolunteerParams): Promise<LunchVolunteerSlot[]> {
    try {
      
      // Make direct POST API request matching the working cURL
      const payload = {
        forSignUpView: true,
        urlid: this.urlId,
        portalid: 0
      };
      
      
      const apiResponse = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify(payload),
      });
      
      if (!apiResponse.ok) {
        throw new Error(`API request failed: ${apiResponse.status} ${apiResponse.statusText}`);
      }

      const responseText = await apiResponse.text();
      
      // Parse the JSON API response
      let slots: LunchVolunteerSlot[] = [];
      
      try {
        const jsonData = JSON.parse(responseText);
        slots = this.parseVolunteerSlotsFromAPI(jsonData);
      } catch (jsonError) {
        throw new Error('API response was not valid JSON');
      }
      
      // Apply date/week filtering if specified
      slots = this.filterSlotsByDate(slots, params);
      
      
      return slots;
    } catch (error) {
      console.error('Lunch volunteer search failed:', error);
      throw error;
    }
  }

  private filterSlotsByDate(slots: LunchVolunteerSlot[], params: LunchVolunteerParams): LunchVolunteerSlot[] {
    if (!params.date && !params.week) {
      return slots; // No filtering
    }

    if (params.date) {
      // Filter by specific date
      return slots.filter(slot => slot.date === params.date);
    }

    if (params.week) {
      const weekRange = this.getWeekRange(params.week);
      if (!weekRange) return slots;
      
      return slots.filter(slot => {
        // Compare dates as strings to avoid timezone issues
        const slotDateStr = slot.date; // Already in YYYY-MM-DD format
        const startDateStr = this.formatDateForComparison(weekRange.start);
        const endDateStr = this.formatDateForComparison(weekRange.end);
        
        
        return slotDateStr >= startDateStr && slotDateStr <= endDateStr;
      });
    }

    return slots;
  }

  private getWeekRange(week: string): { start: Date; end: Date } | null {
    // Get current date in Eastern time by creating date with explicit components
    const now = new Date();
    // Assume Eastern time - we could make this more sophisticated with timezone libraries
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    
    if (week === 'this') {
      // This week: Sunday to Saturday - use local date components to avoid timezone shifts
      const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek);
      const saturday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek + 6);
      
      return { start: sunday, end: saturday };
    }
    
    if (week === 'next') {
      // Next week: Sunday to Saturday - use local date components to avoid timezone shifts
      const dayOfWeek = today.getDay();
      const nextSunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek + 7);
      const nextSaturday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek + 13);
      
      return { start: nextSunday, end: nextSaturday };
    }

    // Try to parse as a date and get the week containing that date
    try {
      const targetDate = new Date(week);
      if (isNaN(targetDate.getTime())) return null;
      
      const dayOfWeek = targetDate.getDay();
      const sunday = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - dayOfWeek);
      const saturday = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - dayOfWeek + 6);
      
      return { start: sunday, end: saturday };
    } catch (error) {
      return null;
    }
  }

  private formatDateForComparison(date: Date): string {
    // Format date as YYYY-MM-DD for comparison, avoiding timezone issues
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private parseVolunteerSlotsFromAPI(data: any): LunchVolunteerSlot[] {
    const slots: LunchVolunteerSlot[] = [];
    
    // The actual SignUpGenius API returns DATA.slots with slot IDs as keys
    if (data.DATA && data.DATA.slots) {
      const slotIds = Object.keys(data.DATA.slots);
      
      
      slotIds.forEach((slotId) => {
        const slotData = data.DATA.slots[slotId];
        
        // Extract date/time information - format like "December, 08 2025 10:45:00"
        const startTime = slotData.starttime;
        const endTime = slotData.endtime;
        const location = slotData.location || 'Dining hall';
        
        if (!startTime) return;
        
        // Parse the date from "December, 08 2025 10:45:00" format
        const date = this.parseSignUpGeniusDate(startTime);
        const dayOfWeek = this.getDayOfWeek(date);
        const time = this.formatTimeRange(startTime, endTime);
        
        
        const positions: VolunteerPosition[] = [];
        
        // Process items (volunteer positions) for this slot
        if (slotData.items && Array.isArray(slotData.items)) {
          slotData.items.forEach((item: any) => {
            const position = item.item || item.itemcomment || '';
            const slotsTotal = item.qty || 0;
            const slotsFilled = item.participantCount || 0;
            
            // For now, we don't have individual volunteer names in this API response
            // We could make additional API calls to get participant details if needed
            const volunteers: string[] = [];
            
            // Only include positions that have a valid name and at least 1 total slot
            if (position && slotsTotal > 0) {
              positions.push({
                position,
                slotsTotal,
                slotsFilled,
                slotsAvailable: slotsTotal - slotsFilled,
                volunteers,
                status: slotsFilled >= slotsTotal ? 'full' : 'available'
              });
            }
          });
        }
        
        // Only include positions that have availability (not full)
        const availablePositions = positions.filter(pos => pos.status === 'available');
        
        if (availablePositions.length > 0) {
          slots.push({
            date,
            dayOfWeek,
            time,
            location,
            slots: availablePositions
          });
        }
      });
    } else {
    }
    
    return slots.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  private parseSignUpGeniusDate(dateTimeStr: string): string {
    // Convert "December, 08 2025 10:45:00" to "2025-12-08"
    // Handle timezone issues by parsing manually to avoid Date constructor ambiguity
    try {
      
      // Extract components manually from format like "December, 08 2025 10:45:00" or "August, 26 2025 11:45:00"
      const dateMatch = dateTimeStr.match(/(\w+),\s*(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
      
      if (!dateMatch) {
        return '';
      }
      
      const [, monthName, day, year, hour, minute, second] = dateMatch;
      
      // Convert month name to number
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November', 'December'];
      const monthIndex = monthNames.indexOf(monthName);
      
      if (monthIndex === -1) {
        return '';
      }
      
      const month = String(monthIndex + 1).padStart(2, '0');
      const dayStr = day.padStart(2, '0');
      
      const result = `${year}-${month}-${dayStr}`;
      
      // Debug: also check what day of week this should be
      const testDate = new Date(parseInt(year), monthIndex, parseInt(day));
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      return result;
    } catch (error) {
      return '';
    }
  }

  private getDayOfWeek(dateStr: string): string {
    try {
      // Parse dateStr as YYYY-MM-DD and calculate day of week without timezone conversion
      const [year, month, day] = dateStr.split('-').map(Number);
      if (!year || !month || !day) return '';
      
      // Create date in Eastern timezone by using Date constructor with explicit components
      // This avoids timezone conversion issues
      const date = new Date(year, month - 1, day); // month is 0-based in Date constructor
      if (isNaN(date.getTime())) return '';
      
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return days[date.getDay()];
    } catch (error) {
      return '';
    }
  }

  private formatTimeRange(startTime: string, endTime: string): string {
    try {
      const start = new Date(startTime);
      const end = new Date(endTime);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return '';
      }
      
      const formatTime = (date: Date) => {
        let hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12; // 0 should be 12
        const minutesStr = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`;
        return `${hours}${minutesStr}${ampm}`;
      };
      
      return `${formatTime(start)} - ${formatTime(end)}`;
    } catch (error) {
      return '';
    }
  }

  private parseVolunteerSlotsFromHTML(html: string): LunchVolunteerSlot[] {
    const $ = cheerio.load(html);
    const slots: LunchVolunteerSlot[] = [];


    // Find all date rows - each <tr> with data-ng-repeat="f in filteredData"
    const dateRows = $('tr[data-ng-repeat*="filteredData"]');

    // If no date rows found, let's see what other structure we can find
    if (dateRows.length === 0) {
      const allTrs = $('tr');
      
      // Look for any elements with date-like content
      const dateElements = $('.signupdata--date-dt');
      
      // Look for slot titles
      const slotTitles = $('.signupdata--slot-title');
      
      // Sample first few elements to see structure
      if (allTrs.length > 0) {
        const firstTr = allTrs.first();
      }
    }

    dateRows.each((_, dateRow) => {
      const $dateRow = $(dateRow);
      
      // Extract date information
      const dateText = $dateRow.find('.signupdata--date-dt').text().trim();
      const dayOfWeek = $dateRow.find('.signupdata--date-day').text().trim();
      const timeText = $dateRow.find('.signupdata--date-time').text().trim();
      const location = $dateRow.find('.signupdata--loc-name, p').filter((_, el) => $(el).text().trim() === 'Dining hall').text().trim() || 'Dining hall';
      
      if (!dateText) {
        return; // Skip if no date found
      }
      
      // Convert date format from MM/DD/YYYY to YYYY-MM-DD
      const date = this.convertDateFormat(dateText);
      
      // Clean up time text (remove line breaks and extra spaces)
      const time = timeText.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Find all volunteer position slots within this date row
      const positions: VolunteerPosition[] = [];
      
      const positionRows = $dateRow.find('tr[data-ng-repeat*="f.items"]');
      
      positionRows.each((_, positionRow) => {
        const $positionRow = $(positionRow);
        
        // Get position title
        const position = $positionRow.find('.signupdata--slot-title').text().trim();
        if (!position) return;
        
        // Get slot availability info
        const slotBadge = $positionRow.find('.signup--badge').text().trim();
        const buttonText = $positionRow.find('.btn-signup').text().trim();
        
        // Parse slot numbers from text like "0 of 2 slots filled" or "All 2 slots filled"
        let slotsTotal = 0;
        let slotsFilled = 0;
        
        if (slotBadge.includes('of') && slotBadge.includes('slots')) {
          // Format: "0 of 2 slots filled" or "1 of 2 slots filled"
          const matches = slotBadge.match(/(\d+)\s+of\s+(\d+)\s+slots/);
          if (matches) {
            slotsFilled = parseInt(matches[1]);
            slotsTotal = parseInt(matches[2]);
          }
        } else if (slotBadge.includes('All') && slotBadge.includes('slots filled')) {
          // Format: "All 2 slots filled"
          const matches = slotBadge.match(/All\s+(\d+)\s+slots filled/);
          if (matches) {
            slotsTotal = parseInt(matches[1]);
            slotsFilled = slotsTotal;
          }
        }
        
        // Get volunteer names
        const volunteers: string[] = [];
        $positionRow.find('.participant-summary--name span').each((_, nameEl) => {
          const name = $(nameEl).text().trim();
          if (name && !name.startsWith('ngIf')) {
            volunteers.push(name);
          }
        });
        
        // Determine status from button text
        const status: 'available' | 'full' = buttonText.includes('Sign Up') ? 'available' : 'full';
        
        positions.push({
          position,
          slotsTotal,
          slotsFilled,
          slotsAvailable: slotsTotal - slotsFilled,
          volunteers,
          status
        });
      });
      
      if (positions.length > 0) {
        slots.push({
          date,
          dayOfWeek,
          time,
          location,
          slots: positions
        });
      }
    });
    
    // Sort by date
    slots.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    return slots;
  }

  private convertDateFormat(dateString: string): string {
    if (!dateString) return '';
    
    try {
      // Convert MM/DD/YYYY to YYYY-MM-DD
      if (dateString.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
        const [month, day, year] = dateString.split('/');
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
      
      return dateString;
    } catch (error) {
      return dateString;
    }
  }
}