/**
 * Job Posting Scraper for Core System Detection
 *
 * BETA - For on-demand use only, not run automatically.
 *
 * Analyzes job postings to detect which core claims/admin systems
 * a healthcare payer uses. Job postings often mention required
 * experience with specific platforms.
 *
 * Core systems detected:
 *   - QNXT (Cognizant)
 *   - Facets (TriZetto/Cognizant)
 *   - HealthEdge (HealthRules Payer)
 *   - TriZetto QNXT
 *   - Amisys (Cognizant)
 *   - Javelina Payer
 *   - Diamond
 *   - HealthRules
 *
 * Rate limiting: 1 request per 5 seconds with random jitter
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../config/index.js';

// ============================================
// CONFIGURATION
// ============================================

// Rate limiting: 5 seconds base + random jitter (0-3 seconds)
const REQUEST_DELAY_MS = 5000;
const JITTER_MAX_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;

// Rotate user agents to avoid detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0',
];

// ============================================
// CORE SYSTEM DEFINITIONS
// ============================================

/**
 * Core claims/admin systems to detect in job postings
 * Each entry has:
 *   - name: Official/common name
 *   - vendor: Parent company
 *   - keywords: Search terms (case-insensitive)
 *   - weight: Higher = more likely to be the primary system
 */
const CORE_SYSTEMS = [
  {
    name: 'QNXT',
    vendor: 'Cognizant/TriZetto',
    keywords: ['qnxt', 'q-nxt', 'trizetto qnxt'],
    weight: 10,
  },
  {
    name: 'Facets',
    vendor: 'TriZetto/Cognizant',
    keywords: ['facets', 'trizetto facets', 'cognizant facets'],
    weight: 10,
  },
  {
    name: 'HealthEdge',
    vendor: 'HealthEdge',
    keywords: ['healthedge', 'health edge', 'healthrules payer', 'healthrules'],
    weight: 10,
  },
  {
    name: 'TriZetto',
    vendor: 'Cognizant',
    keywords: ['trizetto', 'tri-zetto'],
    weight: 5, // Lower weight - often mentioned generically
  },
  {
    name: 'Amisys',
    vendor: 'Cognizant',
    keywords: ['amisys', 'amisys advance', 'amisys managed care'],
    weight: 10,
  },
  {
    name: 'Javelina',
    vendor: 'Javelina',
    keywords: ['javelina payer', 'javelina claims', 'javelina system'],
    weight: 10,
  },
  {
    name: 'Diamond',
    vendor: 'Various',
    keywords: ['diamond claims system', 'diamond claims processing'],
    weight: 8,
  },
  {
    name: 'HealthRules',
    vendor: 'HealthEdge',
    keywords: ['healthrules', 'health rules'],
    weight: 8,
  },
  // Additional common systems
  {
    name: 'Cerner',
    vendor: 'Oracle',
    keywords: ['cerner health plan', 'cerner payer'],
    weight: 7,
  },
  {
    name: 'Epic Tapestry',
    vendor: 'Epic',
    keywords: ['epic tapestry', 'tapestry payer'],
    weight: 8,
  },
  {
    name: 'Cognizant',
    vendor: 'Cognizant',
    keywords: ['cognizant healthcare', 'cognizant payer platform'],
    weight: 4, // Lower - often mentioned as services provider
  },
  {
    name: 'Jiva',
    vendor: 'ZeOmega',
    keywords: ['jiva', 'zeomega jiva', 'zeomega'],
    weight: 7,
  },
];

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get random user agent
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Sleep with random jitter
 */
function sleep(baseMs) {
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

/**
 * Fetch page with rotating user agents
 */
async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      maxRedirects: 5,
    });

    return response.data;
  } catch (error) {
    if (config.logging?.level === 'debug') {
      console.log(`   ⚠️ Could not fetch ${url}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Extract text content from HTML
 */
function extractText(html) {
  if (!html) return '';

  const $ = cheerio.load(html);

  // Remove script, style, nav, footer elements
  $('script, style, nav, footer, header, aside').remove();

  return $('body').text()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find core systems mentioned in text
 * @param {string} text - Text to search
 * @returns {object[]} Array of found systems with match counts
 */
function findCoreSystems(text) {
  if (!text) return [];

  const lowerText = text.toLowerCase();
  const found = [];

  for (const system of CORE_SYSTEMS) {
    let matchCount = 0;
    const matchedKeywords = [];

    for (const keyword of system.keywords) {
      // Count occurrences of this keyword
      const regex = new RegExp(keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = lowerText.match(regex);

      if (matches) {
        matchCount += matches.length;
        matchedKeywords.push(keyword);
      }
    }

    if (matchCount > 0) {
      found.push({
        system: system.name,
        vendor: system.vendor,
        matchCount,
        matchedKeywords,
        weight: system.weight,
        score: matchCount * system.weight,
      });
    }
  }

  // Sort by score (matchCount * weight)
  return found.sort((a, b) => b.score - a.score);
}

// ============================================
// CAREERS PAGE DETECTION
// ============================================

/**
 * Common careers page URL patterns
 */
function getCareersUrls(companyWebsite) {
  if (!companyWebsite) return [];

  let url = companyWebsite.trim().toLowerCase();
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  url = url.replace(/\/$/, '');

  return [
    `${url}/careers`,
    `${url}/jobs`,
    `${url}/about/careers`,
    `${url}/about-us/careers`,
    `${url}/company/careers`,
    `${url}/join-us`,
    `${url}/work-with-us`,
    `${url}/employment`,
    `${url}/opportunities`,
  ];
}

/**
 * Scrape company careers page for job listings
 */
async function scrapeCareerPage(url) {
  const html = await fetchPage(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const text = extractText(html);

  // Look for job-related content
  const hasJobContent = text.includes('apply') ||
                        text.includes('position') ||
                        text.includes('opening') ||
                        text.includes('career') ||
                        text.includes('job');

  if (!hasJobContent) return null;

  return {
    url,
    text,
    systems: findCoreSystems(text),
  };
}

// ============================================
// MAIN ANALYSIS FUNCTIONS
// ============================================

/**
 * Analyze a company's job postings for core system mentions
 *
 * @param {string} companyWebsite - Company website URL
 * @param {string} companyName - Company name (for logging)
 * @returns {Promise<object>} Analysis result
 */
export async function analyzeCompanyJobs(companyWebsite, companyName = 'Unknown') {
  const result = {
    companyName,
    companyWebsite,
    coreSystem: null,
    coreSystemVendor: null,
    confidence: 'unknown',
    source: 'Job Posting',
    allSystemsFound: [],
    pagesAnalyzed: 0,
    error: null,
  };

  if (!companyWebsite) {
    result.error = 'No website provided';
    return result;
  }

  console.log(`   🔍 Analyzing jobs for: ${companyName}`);

  // Try careers page URLs
  const careersUrls = getCareersUrls(companyWebsite);
  const allSystems = [];

  for (const url of careersUrls) {
    console.log(`      Checking: ${url}`);

    const pageResult = await scrapeCareerPage(url);

    if (pageResult && pageResult.systems.length > 0) {
      result.pagesAnalyzed++;
      allSystems.push(...pageResult.systems);
      console.log(`      ✓ Found ${pageResult.systems.length} system mentions`);
    }

    // Rate limiting between requests
    await sleep(REQUEST_DELAY_MS);
  }

  // Aggregate and deduplicate systems found
  const systemCounts = {};
  for (const sys of allSystems) {
    if (!systemCounts[sys.system]) {
      systemCounts[sys.system] = {
        system: sys.system,
        vendor: sys.vendor,
        totalScore: 0,
        totalMatches: 0,
      };
    }
    systemCounts[sys.system].totalScore += sys.score;
    systemCounts[sys.system].totalMatches += sys.matchCount;
  }

  result.allSystemsFound = Object.values(systemCounts)
    .sort((a, b) => b.totalScore - a.totalScore);

  // Determine primary core system
  if (result.allSystemsFound.length > 0) {
    const primary = result.allSystemsFound[0];
    result.coreSystem = primary.system;
    result.coreSystemVendor = primary.vendor;

    // Set confidence based on match strength
    if (primary.totalMatches >= 5) {
      result.confidence = 'high';
    } else if (primary.totalMatches >= 2) {
      result.confidence = 'medium';
    } else {
      result.confidence = 'low';
    }

    console.log(`      ✅ Primary system: ${primary.system} (${primary.totalMatches} mentions, ${result.confidence} confidence)`);
  } else {
    console.log(`      ⚠️ No core systems detected`);
  }

  return result;
}

/**
 * Format analysis result for logging
 */
export function formatResult(result) {
  if (!result.coreSystem) {
    return `❓ No core system detected (${result.pagesAnalyzed} pages analyzed)`;
  }

  const systems = result.allSystemsFound
    .map(s => `${s.system} (${s.totalMatches})`)
    .join(', ');

  return `✅ ${result.coreSystem} [${result.confidence}] | All: ${systems}`;
}

/**
 * Get all core system definitions
 */
export function getCoreSystems() {
  return CORE_SYSTEMS;
}

export default {
  analyzeCompanyJobs,
  formatResult,
  getCoreSystems,
  CORE_SYSTEMS,
};
