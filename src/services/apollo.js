/**
 * Apollo.io API Integration
 *
 * This module handles all interactions with the Apollo.io API
 * for searching companies and contacts in the healthcare/insurance space.
 *
 * Apollo API Documentation: https://apolloio.github.io/apollo-api-docs/
 *
 * API Endpoints Used:
 * - POST /v1/mixed_companies/search - Search for companies
 * - POST /v1/mixed_people/search - Search for contacts
 *
 * Rate Limits ($100/month Basic plan):
 * - ~50 requests per minute
 * - 10,000 records per month for enrichment
 * - Pagination: 25-100 results per page
 */

import axios from 'axios';
import config from '../config/index.js';

// Apollo API base URL
const APOLLO_BASE_URL = 'https://api.apollo.io/v1';

// Rate limiting settings (50 requests/minute = ~1.2 seconds between requests)
const RATE_LIMIT_DELAY_MS = 1500; // 1.5 seconds to be safe
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000; // 5 seconds initial backoff

// Pagination settings
const DEFAULT_PAGE_SIZE = 100; // Max allowed by Apollo
const MAX_PAGES = 10; // Safety limit (1000 results per search)

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create configured axios instance for Apollo API
 */
function createClient() {
  if (!config.apollo.apiKey) {
    throw new Error('APOLLO_API_KEY is not configured. Add it to your .env file.');
  }

  return axios.create({
    baseURL: APOLLO_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    params: {
      api_key: config.apollo.apiKey,
    },
  });
}

/**
 * Make an API request with retry logic and rate limiting
 * @param {Function} requestFn - Function that returns axios promise
 * @returns {Promise<any>} Response data
 */
async function makeRequest(requestFn) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await requestFn();
      await sleep(RATE_LIMIT_DELAY_MS);
      return response.data;
    } catch (error) {
      lastError = error;

      // Handle rate limiting (429)
      if (error.response?.status === 429) {
        const waitTime = RETRY_BACKOFF_MS * attempt;
        console.log(`⏳ Rate limited. Waiting ${waitTime / 1000}s before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(waitTime);
        continue;
      }

      // Handle other errors
      if (error.response?.status >= 500) {
        const waitTime = RETRY_BACKOFF_MS * attempt;
        console.log(`⚠️ Server error (${error.response.status}). Retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(waitTime);
        continue;
      }

      // Client errors (4xx except 429) - don't retry
      if (error.response?.status >= 400) {
        console.error(`❌ API error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`);
        throw error;
      }

      // Network errors - retry
      console.log(`⚠️ Network error. Retry ${attempt}/${MAX_RETRIES}...`);
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  throw lastError;
}

/**
 * Normalize Apollo company data to our database format
 * @param {object} company - Apollo company object
 * @returns {object} Normalized company data
 */
function normalizeCompany(company) {
  return {
    name: company.name || '',
    parentCompany: null, // Apollo doesn't provide this directly
    type: determineCompanyType(company),
    states: extractStates(company),
    employeeCount: company.estimated_num_employees || null,
    memberCount: null, // Not available from Apollo
    coreSystem: null, // Need to extract from job postings later
    coreSystemSource: null,
    website: company.website_url || company.primary_domain || null,
    linkedinUrl: company.linkedin_url || null,
    apolloId: company.id || null,
    dataSources: ['Apollo'],
    // Extra data for filtering/enrichment
    _raw: {
      description: company.short_description || '',
      industry: company.industry || '',
      keywords: company.keywords || [],
      founded: company.founded_year,
      phone: company.phone,
      city: company.city,
      state: company.state,
      country: company.country,
    },
  };
}

/**
 * Determine company type based on Apollo data
 */
function determineCompanyType(company) {
  const text = [
    company.name,
    company.short_description,
    company.industry,
    ...(company.keywords || []),
  ].join(' ').toLowerCase();

  if (text.includes('medicare advantage')) return 'Medicare Advantage';
  if (text.includes('managed care') || text.includes('mco')) return 'MCO';
  if (text.includes('health plan')) return 'Health Plan';
  if (text.includes('insurer') || text.includes('insurance company')) return 'Insurer';

  return 'Other';
}

/**
 * Extract states from Apollo company data
 */
function extractStates(company) {
  const states = [];

  // Add the primary state
  if (company.state && company.country === 'United States') {
    states.push(company.state);
  }

  return states;
}

/**
 * Check if a company is likely a TPA based on name/description
 * @param {object} company - Apollo company object
 * @returns {object} { isTPA: boolean, keywords: string[] }
 */
export function checkIfTPA(company) {
  const tpaKeywords = [
    'tpa',
    'third party admin',
    'third-party admin',
    'claims admin',
    'benefits admin',
    'claims processing',
    'claims management',
    'benefits management',
    'self-funded',
    'self funded',
    'stop loss',
  ];

  const healthcareKeywords = [
    'health',
    'medical',
    'claims',
    'healthcare',
    'dental',
    'vision',
    'pharmacy',
    'prescription',
    'medicare',
    'medicaid',
    'hmo',
    'ppo',
    'wellness',
    'employee benefits',
  ];

  const text = [
    company.name,
    company.short_description || company._raw?.description,
    company.industry,
    ...(company.keywords || company._raw?.keywords || []),
  ].join(' ').toLowerCase();

  const matchedTPA = tpaKeywords.filter(kw => text.includes(kw));
  const matchedHealthcare = healthcareKeywords.filter(kw => text.includes(kw));

  return {
    isTPA: matchedTPA.length > 0,
    isHealthcareFocused: matchedHealthcare.length > 0,
    tpaKeywords: matchedTPA,
    healthcareKeywords: matchedHealthcare,
  };
}

/**
 * Normalize Apollo contact/person data to our database format
 * @param {object} person - Apollo person object
 * @param {string} companyName - Company name for reference
 * @returns {object} Normalized contact data
 */
function normalizeContact(person, companyName) {
  return {
    name: [person.first_name, person.last_name].filter(Boolean).join(' '),
    title: person.title || '',
    email: person.email || null,
    phone: person.phone_numbers?.[0]?.sanitized_number || null,
    linkedinUrl: person.linkedin_url || null,
    source: 'Apollo',
    companyName: companyName,
    // Extra data
    _raw: {
      apolloId: person.id,
      departments: person.departments || [],
      seniority: person.seniority || '',
    },
  };
}

// ============================================
// MAIN API FUNCTIONS
// ============================================

/**
 * Search for companies using a query string
 * Uses q_organization_name for reliable keyword-based searches
 * @param {object} options - Search options
 * @param {string} options.query - Search query (company name/keywords)
 * @param {number} options.maxPages - Maximum pages to fetch (default: 5)
 * @returns {Promise<object[]>} Array of normalized companies
 */
export async function searchCompanies(options = {}) {
  const client = createClient();
  const companies = [];
  const maxPages = options.maxPages || 5;
  const query = options.query || '';

  console.log(`🔍 Searching: "${query}"`);

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    console.log(`   Page ${page}/${maxPages}...`);

    const body = {
      page,
      per_page: DEFAULT_PAGE_SIZE,
      organization_locations: ['United States'],
    };

    // Use q_organization_name for keyword search (this is what Apollo's web UI uses)
    if (query) {
      body.q_organization_name = query;
    }

    console.log(`   Request body: ${JSON.stringify(body)}`);

    try {
      const data = await makeRequest(() =>
        client.post('/mixed_companies/search', body)
      );

      console.log(`   Response: ${data.organizations?.length || 0} organizations, pagination: ${JSON.stringify(data.pagination || {})}`);

      const pageCompanies = (data.organizations || []).map(normalizeCompany);
      companies.push(...pageCompanies);

      console.log(`   ✓ Found ${pageCompanies.length} companies on page ${page}`);

      // Check if there are more pages
      const pagination = data.pagination || {};
      hasMore = pagination.page < pagination.total_pages;
      page++;

    } catch (error) {
      console.error(`   ❌ Error on page ${page}: ${error.message}`);
      if (error.response) {
        console.error(`   Response status: ${error.response.status}`);
        console.error(`   Response data: ${JSON.stringify(error.response.data)}`);
      }
      break;
    }
  }

  console.log(`   Total: ${companies.length} companies found for "${query}"`);
  return companies;
}

/**
 * Search for contacts at a company with specific titles
 * @param {string} companyId - Apollo company ID (or domain)
 * @param {string} companyName - Company name for reference
 * @param {string[]} titleKeywords - Keywords to match in titles
 * @returns {Promise<object[]>} Array of normalized contacts
 */
export async function getContacts(companyId, companyName, titleKeywords = []) {
  if (!companyId && !companyName) {
    throw new Error('Either companyId or companyName is required');
  }

  const client = createClient();
  const contacts = [];

  // Default title keywords for healthcare decision makers
  const defaultTitleKeywords = [
    'Claims',
    'Operations',
    'IT',
    'Technology',
    'CIO',
    'COO',
    'CTO',
    'VP',
    'Vice President',
    'Director',
    'Chief',
    'Head of',
    'Manager',
  ];

  const keywords = titleKeywords.length ? titleKeywords : defaultTitleKeywords;

  console.log(`👥 Getting contacts for: ${companyName || companyId}`);

  const body = {
    page: 1,
    per_page: 50, // Usually enough for key contacts
    person_titles: keywords,
  };

  // Add company filter
  if (companyId) {
    body.organization_ids = [companyId];
  } else if (companyName) {
    body.q_organization_name = companyName;
  }

  try {
    const data = await makeRequest(() =>
      client.post('/mixed_people/search', body)
    );

    const pageContacts = (data.people || []).map(p => normalizeContact(p, companyName));
    contacts.push(...pageContacts);

    console.log(`   Found ${contacts.length} contacts`);

  } catch (error) {
    console.error(`   ❌ Error getting contacts: ${error.message}`);
  }

  return contacts;
}

/**
 * Search for companies with a specific query string
 * This is more flexible than the structured search
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return
 * @returns {Promise<object[]>} Array of normalized companies
 */
export async function searchCompanyByQuery(query, maxResults = 100) {
  const client = createClient();
  const companies = [];

  console.log(`🔍 Searching for: "${query}"`);

  const pages = Math.ceil(maxResults / DEFAULT_PAGE_SIZE);

  for (let page = 1; page <= pages; page++) {
    const body = {
      page,
      per_page: DEFAULT_PAGE_SIZE,
      q_organization_name: query,
      organization_locations: ['United States'],
    };

    try {
      const data = await makeRequest(() =>
        client.post('/mixed_companies/search', body)
      );

      const pageCompanies = (data.organizations || []).map(normalizeCompany);
      companies.push(...pageCompanies);

      if (!data.pagination || data.pagination.page >= data.pagination.total_pages) {
        break;
      }

    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      break;
    }
  }

  return companies.slice(0, maxResults);
}

/**
 * Get account info and usage stats
 * @returns {Promise<object>} Account information
 */
export async function getAccountInfo() {
  const client = createClient();

  try {
    const data = await makeRequest(() =>
      client.get('/auth/health')
    );

    return {
      isValid: true,
      ...data,
    };
  } catch (error) {
    return {
      isValid: false,
      error: error.message,
    };
  }
}

// ============================================
// HEALTHCARE-SPECIFIC SEARCH QUERIES
// ============================================

/**
 * Pre-defined search queries for healthcare payers
 * Each query is a simple string that works with q_organization_name
 * These are the terms you'd type in Apollo's web search
 */
export const HEALTHCARE_QUERIES = [
  // Health Plans & Insurers
  { name: 'Health Insurance', query: 'health insurance' },
  { name: 'Health Plan', query: 'health plan' },
  { name: 'Blue Cross Blue Shield', query: 'blue cross blue shield' },
  { name: 'Anthem', query: 'anthem health' },
  { name: 'Cigna', query: 'cigna' },
  { name: 'Aetna', query: 'aetna' },
  { name: 'Humana', query: 'humana' },
  { name: 'Kaiser', query: 'kaiser permanente' },

  // Managed Care
  { name: 'Managed Care', query: 'managed care' },
  { name: 'HMO', query: 'hmo health' },
  { name: 'PPO', query: 'ppo health' },

  // Medicare & Medicaid
  { name: 'Medicare Advantage', query: 'medicare advantage' },
  { name: 'Medicare Health', query: 'medicare health plan' },
  { name: 'Medicaid Plan', query: 'medicaid health plan' },
  { name: 'Dual Eligible', query: 'dual eligible health' },

  // TPAs & Benefits Admin
  { name: 'Third Party Administrator', query: 'third party administrator' },
  { name: 'TPA Healthcare', query: 'tpa healthcare' },
  { name: 'Claims Administrator', query: 'claims administrator' },
  { name: 'Benefits Administration', query: 'benefits administration healthcare' },
  { name: 'Self Funded', query: 'self funded health' },
  { name: 'Stop Loss', query: 'stop loss insurance' },
];

/**
 * Test Apollo API connection
 * Makes a minimal API call to verify credentials work
 * @returns {Promise<{success: boolean, message: string, details?: object}>}
 */
export async function testConnection() {
  console.log('🔌 Testing Apollo API connection...');

  if (!config.apollo.apiKey) {
    return {
      success: false,
      message: 'APOLLO_API_KEY is not configured',
    };
  }

  console.log(`   API Key: ${config.apollo.apiKey.substring(0, 8)}...`);

  try {
    const client = createClient();

    // Make a minimal search request (1 result)
    const body = {
      page: 1,
      per_page: 1,
      q_organization_name: 'test',
      organization_locations: ['United States'],
    };

    console.log('   Making test request to /mixed_companies/search...');

    const response = await client.post('/mixed_companies/search', body);

    console.log(`   Response status: ${response.status}`);
    console.log(`   Organizations found: ${response.data?.organizations?.length || 0}`);
    console.log(`   Pagination: ${JSON.stringify(response.data?.pagination || {})}`);

    return {
      success: true,
      message: 'Apollo API connection successful',
      details: {
        status: response.status,
        organizationsInTest: response.data?.organizations?.length || 0,
        totalAvailable: response.data?.pagination?.total_entries || 0,
      },
    };
  } catch (error) {
    console.error(`   ❌ Connection failed: ${error.message}`);

    if (error.response) {
      console.error(`   Response status: ${error.response.status}`);
      console.error(`   Response data: ${JSON.stringify(error.response.data)}`);

      return {
        success: false,
        message: `API error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`,
        details: {
          status: error.response.status,
          error: error.response.data,
        },
      };
    }

    return {
      success: false,
      message: `Network error: ${error.message}`,
    };
  }
}

export default {
  searchCompanies,
  searchCompanyByQuery,
  getContacts,
  getAccountInfo,
  checkIfTPA,
  testConnection,
  normalizeCompany,
  normalizeContact,
  HEALTHCARE_QUERIES,
};
