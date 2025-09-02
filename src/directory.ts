import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { VeracrossAuth } from './auth.js';
import { MongoSearchCache } from './mongodb-cache.js';

export interface DirectorySearchParams {
  firstName?: string;
  lastName?: string;
  city?: string;
  postalCode?: string;
  gradeLevel?: string; // CSG Forms: "3/4 Yr Olds", "4/5 Yr Olds", "I"-"XII" (Roman numerals)
  refresh?: boolean; // Optional parameter to bypass cache
  userEmail?: string; // User email for authentication and isolation
}

export interface DirectoryEntry {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  gradeLevel?: string; // CSG Form level (e.g., "VI", "X", "3/4 Yr Olds")
  class?: string; // Student or Parent/Guardian
}

export class DirectorySearch {
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

  public async search(params: DirectorySearchParams): Promise<DirectoryEntry[]> {
    try {
      // User email is required for authentication and isolation
      if (!params.userEmail) {
        throw new Error('User email is required for directory search');
      }

      // Ensure cache is set up for this user
      this.ensureCache(params.userEmail);

      // Check cache first (unless refresh is requested)
      if (!params.refresh) {
        const cachedResults = await this.cache!.get(params);
        if (cachedResults) {
          const cacheInfo = await this.cache!.getCacheInfo(params);
          // Use stderr for logging to avoid corrupting JSON-RPC on stdout
          console.error(`Directory search returned ${cachedResults.length} cached results for user ${params.userEmail} (age: ${cacheInfo.age}min, expires in: ${cacheInfo.expiresIn}min)`);
          return cachedResults;
        }
      }

      await this.auth.ensureAuthenticated(params.userEmail);

      // Build search URL with parameters (exclude refresh and userEmail from URL)
      const searchParams = { ...params };
      delete searchParams.refresh;
      delete searchParams.userEmail;
      const searchUrl = this.buildSearchUrl(searchParams);
      
      
      // Use makeAuthenticatedRequest which now handles cross-domain cookies properly
      const response = await this.auth.makeAuthenticatedRequest(searchUrl);
      
      if (!response.ok) {
        throw new Error(`Directory search request failed: ${response.status}`);
      }

      const html = await response.text();
      
      // Parse the HTML response
      const results = this.parseDirectoryResults(html);
      
      // Cache the results for 24 hours
      await this.cache!.set(params, results, 24);
      // Use stderr for logging to avoid corrupting JSON-RPC on stdout
      console.error(`Directory search fetched ${results.length} fresh results for user ${params.userEmail} and cached for 24 hours`);
      
      return results;
    } catch (error) {
      console.error('Directory search failed:', error);
      throw error;
    }
  }

  private buildSearchUrl(params: DirectorySearchParams): string {
    // Manually build the URL with proper encoding for square brackets
    const schoolCode = process.env.VERACROSS_SCHOOL_CODE || 'csg';
    const baseUrl = `https://portals.veracross.com/${schoolCode}/parent/directory/1`;
    
    // Build query parameters manually to ensure proper encoding
    const queryParams: string[] = [];
    queryParams.push(`directory_entry%5Bfirst_name%5D=${encodeURIComponent(params.firstName || '')}`);
    queryParams.push(`directory_entry%5Blast_name%5D=${encodeURIComponent(params.lastName || '')}`);
    queryParams.push(`directory_entry%5Bcity%5D=${encodeURIComponent(params.city || '')}`);
    queryParams.push(`directory_entry%5Blocation%5D=${encodeURIComponent('')}`);
    queryParams.push(`directory_entry%5Bpostal_code%5D=${encodeURIComponent(params.postalCode || '')}`);
    queryParams.push(`directory_entry%5Bgrade_level%5D=${encodeURIComponent(params.gradeLevel || '')}`);
    queryParams.push(`commit=Search`);
    
    return `${baseUrl}?${queryParams.join('&')}`;
  }

  private parseDirectoryResults(html: string): DirectoryEntry[] {
    const $ = cheerio.load(html);
    const entries: DirectoryEntry[] = [];

    // Parse CSG Veracross directory entries using the actual HTML structure
    const directoryEntries = $('.directory-Entry');
    
    $('.directory-Entry').each((_, element) => {
      const $entry = $(element);
      
      // Get student name and grade
      const studentName = $entry.find('.directory-Entry_Title').first().text().trim();
      if (!studentName) {
        return;
      }
      
      const gradeLevel = $entry.find('.directory-Entry_Tag').first().text().trim();
      
      // Get student email from the header section
      const studentEmailLink = $entry.find('.directory-Entry_Header a[href^="mailto:"]').first();
      const studentEmail = studentEmailLink.length ? studentEmailLink.text().trim() : undefined;
      
      // Get address from household section - it's the first FieldTitle without --blue class
      const addressText = $entry.find('.directory-Entry_FieldTitle').first().text().trim();
      const addressParts = this.parseAddress(addressText);
      
      // Create student entry
      const studentEntry: DirectoryEntry = {
        name: studentName,
        email: studentEmail,
        gradeLevel: gradeLevel || undefined,
        address: addressParts.street,
        city: addressParts.city,
        state: addressParts.state,
        postalCode: addressParts.postalCode,
        class: 'Student'
      };
      entries.push(studentEntry);
      
      // Parse parent/guardian entries - look for blue field titles
      $entry.find('.directory-Entry_FieldTitle--blue').each((_, parentElement) => {
        const $parent = $(parentElement);
        const parentName = $parent.text().trim();
        
        if (!parentName) return;
        
        // Find parent's contact info - they are in the same grid container as the parent name
        const $parentContainer = $parent.closest('.ae-grid__item');
        
        // Look for phone number (Mobile field)
        let phone: string | undefined;
        $parentContainer.find('.directory-Entry_FieldLabel').each((_, labelEl) => {
          const $label = $(labelEl);
          if ($label.text().trim() === 'Mobile') {
            // The value is in the next grid item
            const $valueCell = $label.parent().next('.ae-grid__item--no-padding');
            const phoneLink = $valueCell.find('a[href^="tel:"]');
            if (phoneLink.length) {
              phone = phoneLink.text().trim();
            }
          }
        });
        
        // Look for email address
        let email: string | undefined;
        $parentContainer.find('.directory-Entry_FieldLabel').each((_, labelEl) => {
          const $label = $(labelEl);
          if ($label.text().trim() === 'Email') {
            // The value is in the next grid item
            const $valueCell = $label.parent().next('.ae-grid__item--no-padding');
            const emailLink = $valueCell.find('a[href^="mailto:"]');
            if (emailLink.length) {
              email = emailLink.text().trim();
            }
          }
        });
        
        const parentEntry: DirectoryEntry = {
          name: parentName,
          email: email,
          phone: phone,
          address: addressParts.street,
          city: addressParts.city,
          state: addressParts.state,
          postalCode: addressParts.postalCode,
          class: 'Parent/Guardian'
        };
        entries.push(parentEntry);
      });
    });

    return entries.filter(entry => entry.name); // Remove any entries without names
  }

  private parseAddress(addressText: string): { street?: string; city?: string; state?: string; postalCode?: string } {
    if (!addressText) return {};
    
    // Parse format: "5511 Steele Court, New Albany, OH 43054-8225"
    const parts = addressText.split(',').map(p => p.trim());
    
    if (parts.length >= 3) {
      const street = parts[0];
      const city = parts[1];
      const stateZip = parts[2].split(' ');
      const state = stateZip[0];
      const postalCode = stateZip.slice(1).join(' ').replace('-', '');
      
      return { street, city, state, postalCode };
    }
    
    return { street: addressText };
  }

  private extractText($element: any, selectors: string): string | undefined {
    const selectorList = selectors.split(',').map(s => s.trim());
    
    for (const selector of selectorList) {
      const text = $element.find(selector).first().text().trim();
      if (text) return text;
    }

    return undefined;
  }
}