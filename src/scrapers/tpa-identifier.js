/**
 * TPA Healthcare Identifier
 *
 * Identifies whether a Third Party Administrator (TPA) is healthcare-focused
 * by analyzing their website content for industry-specific keywords.
 *
 * Many TPAs handle non-healthcare claims (auto, property, workers comp),
 * so we need to filter for healthcare-specific ones.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../config/index.js';

// Rate limiting: 1 request per 2 seconds
const REQUEST_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// KEYWORD DEFINITIONS
// ============================================

/**
 * STRONG healthcare indicators
 * If ANY of these are found, is_healthcare_focused = true
 */
const STRONG_HEALTHCARE_KEYWORDS = [
  // Claims types
  'health claims',
  'healthcare claims',
  'medical claims',
  'hospital claims',
  'physician claims',
  'pharmacy claims',
  'dental claims',
  'vision claims',
  'behavioral health claims',
  'mental health claims',

  // Administration terms
  'healthcare administration',
  'health plan administration',
  'medical benefits administration',
  'health benefits administration',
  'healthcare benefit',
  'medical benefit',

  // Specific healthcare terms
  'hipaa',
  'hipaa compliant',
  'hipaa compliance',
  'pharmacy benefits',
  'pharmacy benefit management',
  'pbm',
  'prescription drug',
  'prescription benefits',
  'formulary',
  'prior authorization',
  'preauthorization',
  'medical necessity',
  'utilization management',
  'utilization review',
  'care management',
  'disease management',
  'chronic care',

  // Healthcare IT
  'edi 837',
  'edi 835',
  'healthcare edi',
  'medical coding',
  'icd-10',
  'cpt codes',
  'hcpcs',
  'medical billing',
  'healthcare billing',
  'claim adjudication',

  // Plan types
  'health plan',
  'health insurance',
  'medical plan',
  'self-funded health',
  'self-insured health',
  'erisa health',
  'cobra administration',
  'fsa administration',
  'hsa administration',
  'hra administration',

  // Provider terms
  'provider network',
  'healthcare provider',
  'physician network',
  'hospital network',
  'provider credentialing',

  // Payer terms
  'health payer',
  'healthcare payer',
  'medicare',
  'medicaid',
  'tricare',
  'chip',
  'mco',
  'managed care',
  'hmo',
  'ppo',
  'epo',
  'pos plan',
];

/**
 * WEAK indicators - need more context or manual review
 * Found alone, these could be healthcare OR other industries
 */
const WEAK_HEALTHCARE_KEYWORDS = [
  'claims processing',
  'claims administration',
  'benefits administration',
  'benefits management',
  'third party administrator',
  'tpa services',
  'stop loss',
  'reinsurance',
  'risk management',
  'employee benefits',
  'group benefits',
  'wellness program',
  'member services',
  'eligibility',
  'enrollment',
];

/**
 * NON-healthcare indicators
 * If these are found WITHOUT strong healthcare indicators, likely not healthcare
 */
const NON_HEALTHCARE_KEYWORDS = [
  // Property & Casualty
  'property and casualty',
  'property casualty',
  'p&c claims',
  'property claims',
  'casualty claims',
  'auto claims',
  'automobile claims',
  'vehicle claims',
  'homeowners claims',
  'commercial property',
  'liability claims',

  // Workers Comp (without health context)
  'workers compensation only',
  'work comp only',

  // Retirement/Financial
  'retirement plan',
  'retirement administration',
  '401k',
  '401(k)',
  '403b',
  '403(b)',
  'pension',
  'pension administration',
  'defined benefit',
  'defined contribution',
  'ira administration',

  // Other non-healthcare
  'surety bond',
  'title insurance',
  'crop insurance',
  'marine insurance',
  'aviation insurance',
];

/**
 * URLs to try scraping for a company
 * @param {string} baseUrl - Company website URL
 * @returns {string[]} Array of URLs to try
 */
function getUrlsToScrape(baseUrl) {
  // Normalize base URL
  let url = baseUrl.trim().toLowerCase();
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  url = url.replace(/\/$/, ''); // Remove trailing slash

  return [
    url,
    `${url}/about`,
    `${url}/about-us`,
    `${url}/services`,
    `${url}/solutions`,
    `${url}/what-we-do`,
  ];
}

/**
 * Fetch and extract text content from a URL
 * @param {string} url - URL to fetch
 * @returns {Promise<string|null>} Page text content or null
 */
async function fetchPageText(url) {
  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 3,
    });

    const $ = cheerio.load(response.data);

    // Remove script and style elements
    $('script, style, nav, footer, header').remove();

    // Get text content
    const text = $('body').text()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    return text;

  } catch (error) {
    // Don't log every 404, just return null
    if (error.response?.status !== 404) {
      // Log other errors at debug level
      if (config.logging?.level === 'debug') {
        console.log(`   ⚠️ Could not fetch ${url}: ${error.message}`);
      }
    }
    return null;
  }
}

/**
 * Search for keywords in text
 * @param {string} text - Text to search
 * @param {string[]} keywords - Keywords to find
 * @returns {string[]} Array of found keywords
 */
function findKeywords(text, keywords) {
  if (!text) return [];

  const found = [];
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      found.push(keyword);
    }
  }

  return found;
}

/**
 * Analyze a company's website to determine if they're healthcare-focused
 * @param {string} websiteUrl - Company website URL
 * @param {string} companyName - Company name (for logging)
 * @returns {Promise<object>} Classification result
 */
export async function analyzeCompany(websiteUrl, companyName = 'Unknown') {
  const result = {
    companyName,
    websiteUrl,
    isHealthcareFocused: null,
    confidence: 'unknown',
    needsReview: false,
    strongKeywordsFound: [],
    weakKeywordsFound: [],
    nonHealthcareKeywordsFound: [],
    pagesScraped: 0,
    error: null,
  };

  if (!websiteUrl) {
    result.error = 'No website URL provided';
    result.needsReview = true;
    return result;
  }

  const urls = getUrlsToScrape(websiteUrl);
  let allText = '';

  // Scrape multiple pages
  for (const url of urls) {
    const text = await fetchPageText(url);
    if (text) {
      allText += ' ' + text;
      result.pagesScraped++;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (!allText) {
    result.error = 'Could not fetch any pages';
    result.needsReview = true;
    return result;
  }

  // Find keywords
  result.strongKeywordsFound = findKeywords(allText, STRONG_HEALTHCARE_KEYWORDS);
  result.weakKeywordsFound = findKeywords(allText, WEAK_HEALTHCARE_KEYWORDS);
  result.nonHealthcareKeywordsFound = findKeywords(allText, NON_HEALTHCARE_KEYWORDS);

  // Determine classification
  const strongCount = result.strongKeywordsFound.length;
  const weakCount = result.weakKeywordsFound.length;
  const nonHealthcareCount = result.nonHealthcareKeywordsFound.length;

  // Classification logic
  if (strongCount >= 3) {
    // Multiple strong indicators = definitely healthcare
    result.isHealthcareFocused = true;
    result.confidence = 'high';
  } else if (strongCount >= 1 && nonHealthcareCount === 0) {
    // At least one strong indicator, no non-healthcare = likely healthcare
    result.isHealthcareFocused = true;
    result.confidence = 'medium';
  } else if (strongCount >= 1 && nonHealthcareCount >= 1) {
    // Mixed signals - could do both healthcare and non-healthcare
    result.isHealthcareFocused = true;
    result.confidence = 'low';
    result.needsReview = true;
  } else if (weakCount >= 2 && nonHealthcareCount === 0) {
    // Multiple weak indicators, no non-healthcare = possibly healthcare
    result.isHealthcareFocused = true;
    result.confidence = 'low';
    result.needsReview = true;
  } else if (nonHealthcareCount >= 2 && strongCount === 0) {
    // Multiple non-healthcare indicators, no strong healthcare = not healthcare
    result.isHealthcareFocused = false;
    result.confidence = 'high';
  } else if (nonHealthcareCount >= 1 && strongCount === 0 && weakCount <= 1) {
    // Non-healthcare indicator with no/minimal healthcare = likely not healthcare
    result.isHealthcareFocused = false;
    result.confidence = 'medium';
  } else if (weakCount >= 1) {
    // Only weak indicators = needs review
    result.isHealthcareFocused = null;
    result.confidence = 'unknown';
    result.needsReview = true;
  } else {
    // No relevant keywords found
    result.isHealthcareFocused = null;
    result.confidence = 'unknown';
    result.needsReview = true;
  }

  return result;
}

/**
 * Analyze company name for healthcare indicators (without web scraping)
 * Useful as a quick pre-filter
 * @param {string} name - Company name
 * @returns {object} Quick classification
 */
export function analyzeCompanyName(name) {
  if (!name) return { suggestsHealthcare: false, keywords: [] };

  const lowerName = name.toLowerCase();
  const foundKeywords = [];

  // Check for healthcare terms in company name
  const nameIndicators = [
    'health',
    'healthcare',
    'medical',
    'dental',
    'pharmacy',
    'rx',
    'vision',
    'behavioral',
    'mental health',
    'wellness',
    'care',
    'clinical',
    'patient',
    'hospital',
    'physician',
  ];

  for (const indicator of nameIndicators) {
    if (lowerName.includes(indicator)) {
      foundKeywords.push(indicator);
    }
  }

  // Check for non-healthcare terms
  const nonHealthcareIndicators = [
    'auto',
    'property',
    'casualty',
    'p&c',
    'retirement',
    '401k',
    'pension',
    'surety',
    'title',
  ];

  const nonHealthcareFound = [];
  for (const indicator of nonHealthcareIndicators) {
    if (lowerName.includes(indicator)) {
      nonHealthcareFound.push(indicator);
    }
  }

  return {
    suggestsHealthcare: foundKeywords.length > 0 && nonHealthcareFound.length === 0,
    suggestsNonHealthcare: nonHealthcareFound.length > 0,
    healthcareKeywords: foundKeywords,
    nonHealthcareKeywords: nonHealthcareFound,
  };
}

/**
 * Get all healthcare keywords found (for storing in database)
 * @param {object} analysisResult - Result from analyzeCompany
 * @returns {string[]} Array of all healthcare keywords found
 */
export function getAllHealthcareKeywords(analysisResult) {
  return [
    ...analysisResult.strongKeywordsFound,
    ...analysisResult.weakKeywordsFound,
  ];
}

/**
 * Format analysis result for logging
 * @param {object} result - Analysis result
 * @returns {string} Formatted string
 */
export function formatResult(result) {
  const status = result.isHealthcareFocused === true
    ? '✅ Healthcare'
    : result.isHealthcareFocused === false
      ? '❌ Not Healthcare'
      : '❓ Unknown';

  const confidence = `(${result.confidence} confidence)`;
  const review = result.needsReview ? ' [NEEDS REVIEW]' : '';

  let details = '';
  if (result.strongKeywordsFound.length > 0) {
    details += `\n      Strong: ${result.strongKeywordsFound.slice(0, 5).join(', ')}`;
    if (result.strongKeywordsFound.length > 5) {
      details += ` (+${result.strongKeywordsFound.length - 5} more)`;
    }
  }
  if (result.weakKeywordsFound.length > 0) {
    details += `\n      Weak: ${result.weakKeywordsFound.slice(0, 3).join(', ')}`;
  }
  if (result.nonHealthcareKeywordsFound.length > 0) {
    details += `\n      Non-HC: ${result.nonHealthcareKeywordsFound.join(', ')}`;
  }
  if (result.error) {
    details += `\n      Error: ${result.error}`;
  }

  return `${status} ${confidence}${review}${details}`;
}

export default {
  analyzeCompany,
  analyzeCompanyName,
  getAllHealthcareKeywords,
  formatResult,
  STRONG_HEALTHCARE_KEYWORDS,
  WEAK_HEALTHCARE_KEYWORDS,
  NON_HEALTHCARE_KEYWORDS,
};
