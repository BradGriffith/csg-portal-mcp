import * as cheerio from 'cheerio';
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
      
      // Make authenticated request to directory page
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
    const baseUrl = (this.auth as any).baseUrl; // Access private property
    const searchParams = new URLSearchParams();

    // Add search parameters in Veracross format
    searchParams.append('directory_entry[first_name]', params.firstName || '');
    searchParams.append('directory_entry[last_name]', params.lastName || '');
    searchParams.append('directory_entry[city]', params.city || '');
    searchParams.append('directory_entry[location]', ''); // Empty location field
    searchParams.append('directory_entry[postal_code]', params.postalCode || '');
    searchParams.append('directory_entry[grade_level]', params.gradeLevel || '');
    searchParams.append('commit', 'Search');

    // Use the actual CSG Veracross directory URL format
    return `${baseUrl}/parent/directory/1?${searchParams.toString()}`;
  }

  private parseDirectoryResults(html: string): DirectoryEntry[] {
    const $ = cheerio.load(html);
    const entries: DirectoryEntry[] = [];

    // Parse CSG Veracross directory entries
    $('.directory-Entry').each((_, element) => {
      const $entry = $(element);
      
      // Get student name and grade
      const studentName = $entry.find('.directory-Entry_Title').first().text().trim();
      if (!studentName) return;
      
      const gradeLevel = $entry.find('.directory-Entry_Tag').first().text().trim();
      
      // Get student email
      const studentEmailLink = $entry.find('.directory-Entry_Header a[href^="mailto:"]').first();
      const studentEmail = studentEmailLink.length ? studentEmailLink.text().trim() : undefined;
      
      // Get address from household section
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
      
      // Parse parent/guardian entries - updated for new HTML structure
      $entry.find('.directory-Entry_FieldTitle--blue').each((_, parentElement) => {
        const $parent = $(parentElement);
        const parentName = $parent.text().trim();
        
        if (!parentName) return;
        
        // Find parent's contact info - they are in the same grid container as the parent name
        const $parentContainer = $parent.closest('.ae-grid');
        
        // Look for mobile phone number
        let phone: string | undefined;
        $parentContainer.find('.directory-Entry_FieldLabel').each((_, labelEl) => {
          const $label = $(labelEl);
          if ($label.text().trim() === 'Mobile') {
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