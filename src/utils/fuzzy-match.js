/**
 * Fuzzy Matching Utility
 *
 * Uses Fuse.js to find similar company names in our database.
 * This helps with deduplication when importing from different sources.
 */

import Fuse from 'fuse.js';

/**
 * Common company suffixes to normalize
 */
const COMPANY_SUFFIXES = [
  ', Inc.',
  ', Inc',
  ' Inc.',
  ' Inc',
  ', LLC',
  ' LLC',
  ', Corp.',
  ', Corp',
  ' Corp.',
  ' Corp',
  ', Corporation',
  ' Corporation',
  ', Co.',
  ' Co.',
  ', Company',
  ' Company',
  ', LP',
  ' LP',
  ', L.P.',
  ' L.P.',
  ', LLP',
  ' LLP',
  ' of America',
  ' USA',
  ' US',
  ' (USA)',
  ' (US)',
];

/**
 * Common healthcare company prefixes/words to help with matching
 */
const HEALTHCARE_WORDS = [
  'health',
  'healthcare',
  'medical',
  'blue cross',
  'blue shield',
  'united',
  'aetna',
  'cigna',
  'humana',
  'anthem',
  'kaiser',
  'molina',
  'centene',
  'wellcare',
  'healthnet',
];

/**
 * Normalize a company name for comparison
 * @param {string} name - Company name
 * @returns {string} Normalized name
 */
export function normalizeName(name) {
  if (!name) return '';

  let normalized = name.trim();

  // Remove common suffixes
  for (const suffix of COMPANY_SUFFIXES) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      normalized = normalized.slice(0, -suffix.length).trim();
    }
  }

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ');

  // Convert to lowercase for comparison
  normalized = normalized.toLowerCase();

  return normalized;
}

/**
 * Create a Fuse.js instance for fuzzy searching
 * @param {object[]} items - Items to search through
 * @param {string[]} keys - Keys to search on
 * @returns {Fuse} Fuse instance
 */
export function createFuzzyMatcher(items, keys = ['name']) {
  return new Fuse(items, {
    keys,
    threshold: 0.3, // 0 = exact match, 1 = match anything
    distance: 100,  // How far to search in the string
    includeScore: true,
    minMatchCharLength: 3,
  });
}

/**
 * Find the best match for a company name in a list
 * @param {string} name - Name to search for
 * @param {object[]} existingCompanies - List of existing companies
 * @returns {object|null} Best match with score, or null if no good match
 */
export function findBestMatch(name, existingCompanies) {
  if (!name || !existingCompanies?.length) return null;

  const normalizedInput = normalizeName(name);

  // First, try exact normalized match
  for (const company of existingCompanies) {
    if (normalizeName(company.name) === normalizedInput) {
      return {
        match: company,
        score: 0, // Perfect match
        confidence: 'exact',
      };
    }
  }

  // Create fuzzy matcher
  const fuse = createFuzzyMatcher(existingCompanies);
  const results = fuse.search(normalizedInput);

  if (results.length === 0) return null;

  const best = results[0];

  // Determine confidence level
  let confidence;
  if (best.score < 0.1) {
    confidence = 'high';
  } else if (best.score < 0.25) {
    confidence = 'medium';
  } else if (best.score < 0.4) {
    confidence = 'low';
  } else {
    // Score too low, not a reliable match
    return null;
  }

  return {
    match: best.item,
    score: best.score,
    confidence,
  };
}

/**
 * Merge company data intelligently
 * Keeps existing manual edits while adding new data
 * @param {object} existing - Existing company record
 * @param {object} incoming - New data to merge
 * @returns {object} Merged company data
 */
export function mergeCompanyData(existing, incoming) {
  const merged = { ...existing };

  // Fields that can be updated if currently empty
  const fillIfEmpty = [
    'parent_company',
    'website',
    'linkedin_url',
    'apollo_id',
  ];

  for (const field of fillIfEmpty) {
    if (!merged[field] && incoming[field]) {
      merged[field] = incoming[field];
    }
  }

  // Employee count: update if incoming is more specific
  if (incoming.employee_count && !existing.employee_count) {
    merged.employee_count = incoming.employee_count;
  }

  // States: merge arrays
  if (incoming.states?.length) {
    const existingStates = new Set(merged.states || []);
    for (const state of incoming.states) {
      existingStates.add(state);
    }
    merged.states = Array.from(existingStates);
  }

  // Data sources: merge arrays
  if (incoming.data_sources?.length) {
    const existingSources = new Set(merged.data_sources || []);
    for (const source of incoming.data_sources) {
      existingSources.add(source);
    }
    merged.data_sources = Array.from(existingSources);
  }

  // Core system: only update if current is Unknown or empty
  if (incoming.core_system &&
      (!existing.core_system || existing.core_system_source === 'Unknown')) {
    merged.core_system = incoming.core_system;
    merged.core_system_source = incoming.core_system_source;
  }

  return merged;
}

/**
 * Find duplicates in a list of companies
 * @param {object[]} companies - List of companies to check
 * @returns {object[]} Groups of potential duplicates
 */
export function findDuplicates(companies) {
  const duplicateGroups = [];
  const processed = new Set();

  for (let i = 0; i < companies.length; i++) {
    if (processed.has(i)) continue;

    const company = companies[i];
    const normalizedName = normalizeName(company.name);
    const group = [company];

    for (let j = i + 1; j < companies.length; j++) {
      if (processed.has(j)) continue;

      const other = companies[j];
      const otherNormalized = normalizeName(other.name);

      // Check for exact normalized match
      if (normalizedName === otherNormalized) {
        group.push(other);
        processed.add(j);
      }
    }

    if (group.length > 1) {
      duplicateGroups.push(group);
    }

    processed.add(i);
  }

  return duplicateGroups;
}

export default {
  normalizeName,
  createFuzzyMatcher,
  findBestMatch,
  mergeCompanyData,
  findDuplicates,
};
